# System Proxy（系统代理）

让 DeepSeek Harness 发出的 HTTP(S) 请求走 **Windows 系统代理**（Internet 选项里那个代理设置），
这样在 BoostNet / Clash / v2rayN 等工具里打开「系统代理」后，Harness 的模型请求、联网搜索、
网页抓取、HTTP MCP 等流量都会自动跟着走代理，不需要再手动设置环境变量。

## 工作方式

1. 启动时读取注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`：
   `ProxyEnable`、`ProxyServer`（支持 `host:port` 和 `http=...;https=...` 两种写法）、
   `ProxyOverride`（绕过列表）。
2. 把结果交给 dsh 自带的 `@deepseek-ai/dsh-http-proxy`，由它安装 undici 的全局 dispatcher。
   Node 内置 `fetch` 会解析这个 dispatcher，因此所有走 `fetch` 的模块都被覆盖，
   调用方无需改代码。
3. 卸载或热重载插件时恢复原来的 dispatcher 和环境变量。

本机回环地址（`localhost`、`127.0.0.0/8`、`::1`）始终直连，避免 Web UI 自身绕成死循环。

## 配置（可选）

| 字段 | 说明 |
|---|---|
| `proxy` | 指定代理 URL，覆盖系统代理，例如 `http://127.0.0.1:7890`。设置后不再读取注册表。 |
| `noProxy` | 追加的绕过列表，逗号分隔，例如 `example.com,*.corp.internal`。 |

在插件的 `cordis.patch.yml` 里给这一行加配置即可，例如：

```yaml
- id: system-proxy
  name: '@local/dsh-system-proxy'
  config:
    proxy: http://127.0.0.1:7892
```

## 优先级

1. `config.proxy`（显式覆盖）
2. 进程里已有的 `http_proxy` / `https_proxy` / `all_proxy`（launcher 启动时已按它安装过策略，
   插件不会覆盖，只会退让并记一条日志）
3. Windows 系统代理

## 限制

- 只识别 HTTP/HTTPS 代理；SOCKS 和 PAC（`AutoConfigURL`）不支持，遇到时记日志并保持直连。
- 系统代理的绕过列表里，`10.*`、`192.168.*` 这类地址段无法用后缀表达，会被忽略；
  回环地址仍由安装器强制绕过。
- 修改系统代理后需要重载插件（重启 Harness）才生效：dispatcher 是进程级的，
  换掉它会让正在进行的请求中断。
- 插件会把解析后的 `http_proxy` / `https_proxy` / `no_proxy` 写进进程环境变量，
  因此子进程（curl、git、pnpm 等）也会使用代理，这与打开系统代理的预期一致。

## 安装

适用 DeepSeek Harness Desktop（Windows），依赖 Harness 内置的 `@deepseek-ai/dsh-http-proxy`。

```powershell
git clone https://github.com/Wit-2k/dsh-system-proxy.git
```

然后在 DSH 会话里让 Agent 用 `plugin_manager` 的 `install_bundle` 指向克隆下来的目录，
或在 Web 的「插件」页安装这个本地目录。装好后插件默认启用、立即生效；
之后每次启动 Harness 都会重新读取系统代理。

卸载：在插件页移除 `@local/dsh-system-proxy`，恢复直连。

## 验证

确认 Host 进程确实在连代理端口：

```powershell
Get-NetTCPConnection -RemotePort 7892 -State Established |
  Select-Object RemoteAddress,RemotePort,OwningProcess
```

有到代理端口的 Established 连接，说明 Harness 的请求已经走代理。
