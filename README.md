# Factory Anthropic Proxy

将 Factory 的 Claude 模型接口接入 Anthropic Messages 客户端与 Claude Code。

支持普通 JSON、实时 SSE、工具调用、工具结果、thinking 和缓存字段。默认监听 `127.0.0.1:8787`，使用独立代理 Key；Factory 凭据只由代理读取。

## Windows 使用

1. 下载 [最新正式版](https://github.com/hxx344/factory-anthropic-proxy/releases/latest) 的 `.tgz`，用 Windows 自带 `tar` 或解压软件解压，进入 `package` 文件夹。
2. 确保同一 Windows 用户已登录 Factory Desktop 或 Droid，双击 `start.cmd`。脚本复用 Node.js 22+；缺少时下载并校验固定版本的便携 Node，缓存后复用。
3. 保留代理窗口，在另一个终端运行已安装的 Claude Code：

```powershell
node bin/proxy.mjs claude
```

若使用脚本下载的便携 Node，可用它的实际路径执行上述命令，或安装 Node.js 22+。Claude Code 的原生程序不在 PATH 时，设置 `CLAUDE_PATH` 为其 `.exe` 的绝对路径。

也可以在已有 Node.js 环境中启动：

```powershell
node bin/proxy.mjs init
node bin/proxy.mjs serve
```

`init` 自动生成 256-bit 随机代理 Key，写入本地 `proxy.config.json`；重复运行保留配置。`Ctrl+C` 停止前台服务。检查运行状态：

```powershell
node bin/proxy.mjs status
```

## 接入其他客户端

客户端的 Base URL 填 `http://127.0.0.1:8787`，API Key 使用 `proxy.config.json` 的 `proxyKey`。也可把配置导入当前终端后直接运行 `claude`：

```powershell
node bin/proxy.mjs client-env --shell powershell | Invoke-Expression
claude
```

```bash
eval "$(node bin/proxy.mjs client-env --shell bash)"
claude
```

`client-env` 会输出代理 Key，供当前终端设置环境变量；不会输出 Factory 凭据。`claude` 子命令直接为子进程设置环境，剔除继承的 `FACTORY_*` 变量，不打印 Key，也不改写 Claude Code 的持久配置。

标准接口：

| 接口 | 行为 |
| --- | --- |
| `POST /v1/messages` | 普通与流式 Messages，支持 `?beta=true` |
| `GET /v1/models`、`GET /v1/models/:id` | 当前配置中的模型发现列表 |
| `POST /v1/messages/count_tokens` | 标准 Anthropic `404`，客户端可自行估算 |
| `GET /healthz` | 只返回进程健康状态与版本，不检查上游可用性 |

## 凭据与配置

支持在项目目录的 `.env` 中配置 `FACTORY_API_KEY`。只有未配置该变量时才使用本机登录；配置了 Key 但被拒绝时，不会切换到账户登录。

```dotenv
FACTORY_API_KEY=fk-your-factory-key
# 可选
FACTORY_ORG_ID=your-org-id
FACTORY_REGION=global
```

本机登录方式已实测。Factory API Key 方式已做模拟契约测试；首版没有真实 API Key，未做在线验收。

登录模式通过 Factory 已安装的 `keytar` 模块读取当前用户的系统密钥，再在内存中解密 `auth.v2.keyring`；也支持官方 `auth.v2.file` / `auth.v2.key` 存储。不打包 Factory 原生模块。无法自动定位时，可设置 `FACTORY_KEYTAR_PATH`；仅安装 Droid 且采用系统 keyring 时，需要提供本机已有的兼容 `keytar` 模块。macOS 路径有兼容处理，但首版没有实际设备验收。

令牌到期时，代理有界调用 `droid doctor --checks auth --json`，由官方工具刷新。多个请求共享一次刷新；失败有冷却和超时。上游返回 `401` 后，只有读到变化后的令牌才重放一次请求。代理不直接使用或改写共享 refresh token。账号被撤销或官方工具无法刷新时，需要重新登录。真实到期刷新尚未做等待过期的在线测试；合成凭据已覆盖到期、并发、失败与恢复行为。

配置参考 [proxy.config.example.json](proxy.config.example.json)：

- `defaultModel`：Claude Code 启动模型，默认 `claude-sonnet-4-6`。
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

协议参考：[Claude Code 网关兼容说明](https://code.claude.com/docs/en/llm-gateway-protocol)、[Factory 自定义模型文档](https://docs.factory.com/model-independence/byok)。
