# v0.1.1 验证记录与兼容性更正

日期：2026-10-20。Windows 原生环境，Node.js v24.15.0；未使用 WSL。

## 自动化验证

以下结果沿用 v0.1.0 的验证记录；v0.1.1 只修正文档、启动提示和版本元数据，未改变代理转发行为，也未重复运行这组测试。

- 核心代理：29 个测试，覆盖鉴权隔离、固定上游、模型映射、system 保留、JSON/SSE、分片工具参数、401 有界恢复、客户端取消、总超时与空闲超时、chunked 请求大小、并发限额恢复和错误脱敏。
- 凭据：21 个测试，覆盖 AES-GCM 解密/篡改、API Key 优先、官方刷新入口、并发合并、冷却、超时与用户 profile 一致性；POSIX 权限分支由 Ubuntu CI 验证。
- 配置：4 个测试，覆盖随机 Key、重复初始化保留、远端监听显式配置、非法配置与错误信息脱敏。
- Claude 启动器：1 个隔离子进程测试，确认只传代理凭据并剔除 Factory 凭据与互斥后端变量。
- Linux 安装：原生 Ubuntu CI 验证首次安装、重复跳过、升级保留配置以及坏包拒绝。具体最终 CI 结果以对应提交的 Actions 为准。

## 真实上游与客户端

基础接口已使用当前用户的 Factory 登录和后续提供的真实 Factory API Key，通过本地代理调用。凭据未输出或提交到仓库。

| 检查 | 结果 |
| --- | --- |
| Anthropic SDK 0.135.0 普通 Messages | 返回 `PROXY_SDK_OK` |
| SDK 流式强制工具调用 | 正确读取 `tool_use` 与参数；首事件约 1.4 秒 |
| SDK 回传 `tool_result` | 返回 `PROXY_TOOL_OK` |
| 默认模型 `claude-sonnet-4-6` | HTTP 200，正常文本响应 |
| 真实 Factory API Key 普通 Sonnet 4.6 请求 | HTTP 200，返回 `API_KEY_OK` |
| Factory token 计数接口 | HTTP 404；代理如实返回不支持 |

SDK 工具测试使用 `claude-haiku-4-5-20251001`。

## Claude Desktop 实际 GUI 验收

Windows Store Claude `2.42304.2.0` 使用本地 `Factory Local` 候选配置：`gateway` / `static`、`http://127.0.0.1:8787`、`x-api-key`、`modelDiscoveryEnabled: false`、`desktopHome: no-vm`，显式模型为 `claude-sonnet-4-6`、`claude-opus-5-5`、`claude-haiku-4-5-20251001`。Desktop 使用代理独立 Key，Factory API Key 由代理读取。

实际 Chat 界面已可进入，选择 Sonnet 4.6 / Medium 发送一条合成消息后，界面显示 `Failed to authenticate · API Error: 403 Forbidden`。同期代理的三个上游响应依次为 `200`、`403`、`200`；主聊天请求对应 `403`，未得到有效聊天回复。基础或标题请求的 `200` 不能证明 Desktop 聊天可用。

结论：Claude Desktop 聊天验收未通过；保留该候选配置不代表已兼容。此次仅记录实际观察，不推断未公开的上游拒绝规则。官方要求见 [Claude Desktop Gateway 文档](https://claude.com/docs/third-party/claude-desktop/gateway)。

验收后已恢复并重启 Desktop 的原连接，核实原 profile 内容与备份一致；`Factory Local` 候选配置仍保留。

## 历史更正：Claude Code

撤回原 Claude Code 最小模式文本/Read 测试的 Factory 端到端通过结论：测试未排除用户级旧网关配置覆盖，成功响应不能确认来自 Factory。后续固定本地代理和凭据来源后，Claude Code `2.1.303` 普通及交互模式在 Factory 本机登录与真实 API Key 下均返回 `403`；同一凭据的基础 Messages 请求返回 `200`。启动器的环境隔离测试不等于上游兼容验收。

未在线验证：等待真实令牌到期后的刷新、macOS keychain、所有模型和全部 Anthropic beta 功能。对应模拟测试不等同于真实服务验收。
