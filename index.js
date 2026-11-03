/**
 * Route the Harness' outbound HTTP through the Windows system proxy.
 *
 * The Harness resolves one process-wide proxy policy and installs it as undici's global
 * dispatcher, which is what Node's built-in `fetch` resolves; LLM, web-search, web-fetch and
 * HTTP MCP traffic all go through it without knowing the policy exists. The launcher reads that
 * policy only from proxy environment variables, so a machine whose system proxy is switched on in
 * Windows Internet Settings is still sent direct. This plugin closes that gap: it reads the
 * WinINET configuration (registry), hands the same policy to the same installer, and leaves the
 * launch policy alone when the user already exported one.
 *
 * Optional `config` fields (both strings, both optional):
 *   - `proxy`:   use this proxy URL instead of the Windows system proxy, e.g. `http://127.0.0.1:7890`.
 *   - `noProxy`: extra bypass entries, comma separated, appended to the system bypass list.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The shipped library that owns the process-wide dispatcher and the child-environment overlay. */
const PROXY_PACKAGE = '@deepseek-ai/dsh-http-proxy'
/** Registry key holding the per-user WinINET (system) proxy configuration. */
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
/** Every name the launcher reads its launch policy from; any non-empty one means it already acted. */
const PROXY_ENV_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']

/**
 * Build the two log sinks used by this plugin.
 *
 * The Cordis logger writes to the Host's own log stream; the console fallback keeps a diagnostic
 * visible when a bare context has no logger service.
 * @param ctx - the plugin context.
 * @returns bounded info and warning reporters.
 */
function reporters(ctx) {
  try {
    const logger = ctx.logger('system-proxy')
    return {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
    }
  } catch {
    return {
      info: (message) => console.log(`[system-proxy] ${message}`),
      warn: (message) => console.warn(`[system-proxy] ${message}`),
    }
  }
}

/**
 * Read one value from the current user's Internet Settings key.
 *
 * `reg.exe` output is parsed by token rather than by position, so a localized Windows display
 * string does not matter: the value name and the `REG_*` type are never translated.
 * @param name - the registry value name.
 * @returns the raw value text, or undefined when the value, the key, or the tool is unavailable.
 */
function readInternetSetting(name) {
  try {
    const output = execFileSync('reg.exe', ['query', INTERNET_SETTINGS, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    for (const line of output.split(/\r?\n/u)) {
      const match = /^\s*(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/u.exec(line)
      if (match !== null && match[1].toLowerCase() === name.toLowerCase()) return match[3].trim()
    }
  } catch {
    // An absent value, an absent key, or a host without reg.exe all mean the same thing here.
  }
  return undefined
}

/**
 * Interpret a REG_DWORD proxy switch.
 * @param value - the raw registry text, hexadecimal or decimal.
 * @returns true when the switch is on.
 */
function switchedOn(value) {
  if (value === undefined) return false
  const parsed = /^0x/iu.test(value) ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed !== 0
}

/**
 * Turn a registry proxy address into a URL the policy accepts.
 * @param raw - the address as Windows stores it, usually `host:port`.
 * @returns the proxy URL, or undefined for an empty address.
 */
function proxyUrl(raw) {
  const value = raw.trim()
  if (value === '') return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return value
  return `http://${value}`
}

/**
 * Split the ProxyServer value into its per-scheme proxies.
 *
 * Windows stores either one `host:port` for every protocol or a `http=...;https=...;socks=...`
 * list. A bare address is the only accepted form without a scheme, and HTTPS falls back to the
 * HTTP proxy, which is what the rest of the Harness already assumes.
 * @param raw - the ProxyServer value.
 * @returns the HTTP and HTTPS proxy URLs, either of which may be undefined.
 */
function parseProxyServer(raw) {
  const byScheme = new Map()
  const bare = []
  for (const part of raw.split(';')) {
    const entry = part.trim()
    if (entry === '') continue
    const scheme = /^([a-z][a-z0-9+.-]*)\s*=\s*(.+)$/iu.exec(entry)
    if (scheme === null) {
      bare.push(entry)
      continue
    }
    const kind = scheme[1].toLowerCase()
    if ((kind === 'http' || kind === 'https') && !byScheme.has(kind)) byScheme.set(kind, scheme[2])
  }
  const httpProxy = proxyUrl(byScheme.get('http') ?? bare[0] ?? '')
  const httpsProxy = proxyUrl(byScheme.get('https') ?? byScheme.get('http') ?? bare[0] ?? '')
  return { httpProxy, httpsProxy }
}

/**
 * Translate the Windows ProxyOverride list into the policy's bypass list.
 *
 * A leading wildcard means the host and every subdomain beneath it, which is exactly what the
 * policy's entries already mean. A range such as `10.*` cannot be expressed, so it is dropped;
 * loopback is bypassed by the installer regardless of what this list says.
 * @param raw - the ProxyOverride value, semicolon separated.
 * @returns a comma separated bypass list, `*` for bypass everything, or an empty string.
 */
function bypassList(raw) {
  if (raw === undefined) return ''
  const entries = []
  for (const part of raw.split(';')) {
    const entry = part.trim().toLowerCase()
    if (entry === '' || entry === '<local>') continue
    if (entry === '*') return '*'
    const host = entry.replace(/^\*+\.?/u, '')
    if (host === '' || host.includes('*')) continue
    entries.push(host)
  }
  return entries.join(',')
}

/**
 * Resolve the proxy policy the Windows system proxy describes.
 * @returns the policy fields, or a `reason` explaining why there is none.
 */
function systemProxy() {
  const enabled = readInternetSetting('ProxyEnable')
  const server = readInternetSetting('ProxyServer')
  const autoConfig = readInternetSetting('AutoConfigURL')
  if (enabled === undefined && server === undefined) {
    return { reason: 'the Windows Internet Settings proxy values are unavailable' }
  }
  if (!switchedOn(enabled)) {
    return {
      reason:
        autoConfig === undefined || autoConfig === ''
          ? 'the Windows system proxy is off'
          : `the Windows system proxy is off (the PAC script ${autoConfig} is not supported)`,
    }
  }
  if (server === undefined || server.trim() === '') {
    return { reason: 'the Windows system proxy is enabled without a server address' }
  }
  const { httpProxy, httpsProxy } = parseProxyServer(server)
  const reachable = httpsProxy ?? httpProxy
  if (reachable === undefined) {
    return { reason: `the Windows system proxy address "${server}" is not a usable HTTP proxy` }
  }
  return {
    httpProxy,
    httpsProxy: reachable,
    noProxy: bypassList(readInternetSetting('ProxyOverride')),
  }
}

/**
 * Load the shipped proxy library.
 *
 * A bundle installed in a profile resolves its own dependencies, but `@deepseek-ai/dsh-http-proxy`
 * ships with dsh rather than with this package, so the module is located through an anchor inside
 * the running installation: the Host entry script, then the runtime tree the Desktop shell passes
 * to it. A profile that does install the package as a dependency still reaches the bare import.
 * @returns the library namespace.
 */
async function loadProxyLibrary() {
  const anchors = [import.meta.url]
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') anchors.push(pathToFileURL(entry).href)
  const runtimeDir = process.argv[2]
  if (typeof runtimeDir === 'string' && runtimeDir !== '') {
    anchors.push(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).href)
  }
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve(PROXY_PACKAGE)
      return await import(pathToFileURL(resolved).href)
    } catch {
      // This anchor does not know the package; the next one may.
    }
  }
  return await import(PROXY_PACKAGE)
}

/**
 * Install the system proxy as this process's outbound HTTP policy.
 * @param ctx - the plugin context, which owns the disposer.
 * @param config - optional `proxy` override and extra `noProxy` entries.
 */
export async function apply(ctx, config = {}) {
  const { info, warn } = reporters(ctx)
  const override = typeof config.proxy === 'string' && config.proxy.trim() !== '' ? config.proxy.trim() : undefined

  if (override === undefined) {
    if (process.platform !== 'win32') {
      info('system proxy detection is Windows only; set config.proxy to route through a proxy on this platform')
      return
    }
    const exported = PROXY_ENV_NAMES.find((name) => (process.env[name] ?? '').trim() !== '')
    if (exported !== undefined) {
      info(`${exported} is already set; keeping the launch proxy policy the Harness installed from it`)
      return
    }
  }

  const resolved =
    override === undefined
      ? systemProxy()
      : { httpProxy: proxyUrl(override), httpsProxy: proxyUrl(override), noProxy: '' }
  if (resolved.httpProxy === undefined && resolved.httpsProxy === undefined) {
    info(resolved.reason ?? 'no proxy is configured')
    return
  }

  const extraBypass = typeof config.noProxy === 'string' ? config.noProxy.trim() : ''
  const noProxy = [resolved.noProxy, extraBypass].filter((part) => part !== undefined && part !== '').join(',')
  const values = new Map([
    ['http_proxy', resolved.httpProxy],
    ['https_proxy', resolved.httpsProxy],
    ['no_proxy', noProxy],
  ])
  // The policy resolver reads this shape: `get(name)` answers the value and the layer that held it.
  const environment = {
    get: (name) => {
      const value = values.get(name)
      return value === undefined ? undefined : { value, source: 'system-proxy' }
    },
  }

  const { installProxyFromEnvironment } = await loadProxyLibrary()
  const dispose = await installProxyFromEnvironment(environment, (message) => warn(message))
  ctx.effect(() => dispose)
  info(
    `outbound HTTP now goes through ${resolved.httpsProxy ?? resolved.httpProxy}` +
      ` (bypass: ${noProxy === '' ? 'loopback only' : noProxy})`,
  )
}
