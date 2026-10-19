# Factory Anthropic Proxy

为 Factory 的 Claude 模型提供 Anthropic Messages 基础接口。

**当前状态（2026-10-20）：Claude Desktop 实际聊天尚未通过。** 基础 Messages 请求已返回 HTTP 200，但已安装的 Windows Claude Desktop 在真实 Chat 界面发送消息时返回 `Failed to authenticate · API Error: 403 Forbidden`，同期代理记录上游 HTTP 403。连接测试或标题请求成功不代表可以聊天。详见 [验证记录](docs/verification.md)。

支持普通 JSON、实时 SSE、工具调用、工具结果、thinking 和缓存字段。默认监听 `127.0.0.1:8787`，使用独立代理 Key；Factory 凭据只由代理读取。

## Windows 使用

1. 下载 [最新正式版](https://github.com/hxx344/factory-anthropic-proxy/releases/latest) 的 `.tgz`，用 Windows 自带 `tar` 或解压软件解压，进入 `package` 文件夹。
2. 在 `.env` 配置 Factory API Key，或使用同一 Windows 用户已登录的 Factory Desktop / Droid 凭据，然后双击 `start.cmd`。脚本复用 Node.js 22+；缺少时下载并校验固定版本的便携 Node，缓存后复用。
3. 保留代理窗口，在支持 Anthropic Messages 的客户端中设置下文的 URL 和代理 Key。以下普通请求用于检查基础接口；Claude Desktop 的限制见下文。

也可以在已有 Node.js 环境中启动：

```powershell
node bin/proxy.mjs init
node bin/proxy.mjs serve
```

`init` 自动生成 256-bit 随机代理 Key，写入本地 `proxy.config.json`；重复运行保留配置。`Ctrl+C` 停止前台服务。检查运行状态：

```powershell
node bin/proxy.mjs status
```

## 接入 Anthropic Messages 客户端

客户端的 Base URL 填 `http://127.0.0.1:8787`，API Key 使用 `proxy.config.json` 的 `proxyKey`。可以先用一条普通请求验证：

```powershell
$proxy = Get-Content proxy.config.json | ConvertFrom-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/v1/messages' -ContentType 'application/json' -Headers @{ 'x-api-key' = $proxy.proxyKey } -Body '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"Reply exactly OK."}]}'
```

`client-env` 可输出代理 Key 供当前终端设置环境变量，不输出 Factory 凭据。仓库保留的 `claude` 启动子命令只负责环境传递；此前 Claude Code 兼容性结论已撤回，见 [历史更正](docs/verification.md#历史更正claude-code)。

标准接口：

| 接口 | 行为 |
| --- | --- |
| `POST /v1/messages` | 普通与流式 Messages，支持 `?beta=true` |
| `GET /v1/models`、`GET /v1/models/:id` | 当前配置中的模型发现列表 |
| `POST /v1/messages/count_tokens` | 标准 Anthropic `404`，客户端可自行估算 |
| `GET /healthz` | 只返回进程健康状态与版本，不检查上游可用性 |

## Claude Desktop 已验证范围与限制

已在 Windows Store Claude `2.42304.2.0` 的实际 Chat 界面验证第三方 Gateway 配置：本地地址 `http://127.0.0.1:8787`、Static API key、`x-api-key`、关闭模型发现，显式列出 Sonnet 4.6、Opus 5.5 和 Haiku 4.5，并使用 `desktopHome: no-vm`。界面可以进入 Chat，但 Sonnet 4.6 / Medium 的合成消息返回上游 `403`，未通过聊天验收。这份配置仅为已测试候选，不是可用接入教程。

代理保留 Messages 的工具、thinking 与缓存字段，不保证上游接受 Desktop 的完整请求。官方 Gateway 要求包含流式 Messages 和工具调用；基础请求、连接测试或标题请求的 `200` 不能替代实际聊天验证。配置入口和协议要求见 [Claude Desktop 官方 Gateway 文档](https://claude.com/docs/third-party/claude-desktop/gateway)。

## 凭据与配置

支持在项目目录的 `.env` 中配置 `FACTORY_API_KEY`。只有未配置该变量时才使用本机登录；配置了 Key 但被拒绝时，不会切换到账户登录。

使用 API Key 时，无需保持 Factory Desktop 或 Droid 运行；本地代理进程需要持续运行。

```dotenv
FACTORY_API_KEY=fk-your-factory-key
# 可选
FACTORY_ORG_ID=your-org-id
FACTORY_REGION=global
```

本机登录与真实 Factory API Key 的基础模型请求均已在线实测。真实 API Key 的 Sonnet 4.6 请求返回 `200`；这不代表 Claude Desktop 已兼容。

登录模式通过 Factory 已安装的 `keytar` 模块读取当前用户的系统密钥，再在内存中解密 `auth.v2.keyring`；也支持官方 `auth.v2.file` / `auth.v2.key` 存储。不打包 Factory 原生模块。无法自动定位时，可设置 `FACTORY_KEYTAR_PATH`；仅安装 Droid 且采用系统 keyring 时，需要提供本机已有的兼容 `keytar` 模块。macOS 路径有兼容处理，但首版没有实际设备验收。

令牌到期时，代理有界调用 `droid doctor --checks auth --json`，由官方工具刷新。多个请求共享一次刷新；失败有冷却和超时。上游返回 `401` 后，只有读到变化后的令牌才重放一次请求。代理不直接使用或改写共享 refresh token。账号被撤销或官方工具无法刷新时，需要重新登录。真实到期刷新尚未做等待过期的在线测试；合成凭据已覆盖到期、并发、失败与恢复行为。

配置参考 [proxy.config.example.json](proxy.config.example.json)：

- `defaultModel`：默认模型配置，默认 `claude-sonnet-4-6`。
- `models`：模型发现列表；列出模型不代表账号有该模型权限，实际由 Factory 校验。
- `modelAliases`：显式名称映射，例如 `{"sonnet":"claude-sonnet-4-6"}`。未配置的 Claude 模型 ID 原样发送。
- `timeoutMs`、`idleTimeoutMs`：单次请求总超时与上游空闲超时；默认 300 秒和 90 秒。
- `maxBodyBytes`、`maxConcurrentRequests`：默认 32 MiB 与 8 个并发请求。
- `host`、`port`：监听地址；非回环地址需要显式 `allowRemote: true`。服务器接入方式见 [部署说明](docs/deployment.md)。

可通过 `PROXY_CONFIG` 选择配置文件，通过 `PROXY_API_KEY` 覆盖代理 Key，通过 `FACTORY_CLIENT_VERSION` 覆盖 Factory 协议使用的客户端版本。地区仅允许 `global`、`eu`、`us`；欧区使用 Factory 欧区地址，其他地区使用全局地址。

## 协议适配范围

Factory 实测要求 system 以其 Droid 身份提示词开头。代理会在原 system 前补充这一条文本，保留原内容和 `cache_control`，不重复添加已有前缀。因此发送到上游的 system 比客户端原请求多这一条。Messages 的工具、签名、thinking 与其他有效字段保持原样；不保证 Factory 支持 Anthropic 的所有 beta 功能。

上游地址固定为 Factory HTTPS 接口，禁止重定向，不接受客户端指定上游。客户端提供的 cookie、Factory 鉴权与路由头不会传入上游。SSE 按字节转发并使用背压，客户端断开会取消上游；已开始的流不重试。不记录提示词、响应内容或凭据。

本项目没有实现 Files、Batches、Managed Agents 或 Anthropic 管理 API。Factory 内部网关的鉴权和协议要求可能随版本变化。

## 开发与发布

运行时无 npm 依赖，Node.js 22+：

```powershell
npm test
npm run check
npm run package
```

源码包与 `SHA256SUMS` 写入 `dist/`；打包使用白名单，不包含本地配置、凭据、会话或运行日志。CI 使用 Windows 和原生 Ubuntu，不使用 WSL。在线验收范围见 [验证记录](docs/verification.md)。

协议参考：[Claude Desktop Gateway 文档](https://claude.com/docs/third-party/claude-desktop/gateway)、[Factory 自定义模型文档](https://docs.factory.com/model-independence/byok)。
