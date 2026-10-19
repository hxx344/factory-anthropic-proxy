# v0.1.0 验证记录

日期：2026-10-20。Windows 原生环境，Node.js v24.15.0；未使用 WSL。

## 自动化验证

- 核心代理：29 个测试，覆盖鉴权隔离、固定上游、模型映射、system 保留、JSON/SSE、分片工具参数、401 有界恢复、客户端取消、总超时与空闲超时、chunked 请求大小、并发限额恢复和错误脱敏。
- 凭据：21 个测试，覆盖 AES-GCM 解密/篡改、API Key 优先、官方刷新入口、并发合并、冷却、超时与用户 profile 一致性；POSIX 权限分支由 Ubuntu CI 验证。
- 配置：4 个测试，覆盖随机 Key、重复初始化保留、远端监听显式配置、非法配置与错误信息脱敏。
- Claude 启动器：1 个隔离子进程测试，确认只传代理凭据并剔除 Factory 凭据与互斥后端变量。
- Linux 安装：原生 Ubuntu CI 验证首次安装、重复跳过、升级保留配置以及坏包拒绝。具体最终 CI 结果以对应提交的 Actions 为准。

## 真实上游与客户端

使用当前用户的 Factory 登录，通过已运行的本地代理调用；没有输出或保存 Factory 凭据。

| 检查 | 结果 |
| --- | --- |
| Anthropic SDK 0.135.0 普通 Messages | 返回 `PROXY_SDK_OK` |
| SDK 流式强制工具调用 | 正确读取 `tool_use` 与参数；首事件约 1.4 秒 |
| SDK 回传 `tool_result` | 返回 `PROXY_TOOL_OK` |
| Claude Code 2.1.303 文本请求 | 返回 `PROXY_CLAUDE_OK` |
| Claude Code 只读工具调用 | 两轮完成，读取测试文件并返回 `PROXY_READ_TOOL_OK` |
| 默认模型 `claude-sonnet-4-6` | HTTP 200，正常文本响应 |
| Factory token 计数接口 | HTTP 404；代理如实返回不支持 |

SDK 与 Claude Code 工具测试使用 `claude-haiku-4-5-20251001`。Claude Code 使用 `--bare` 与 `--no-session-persistence`，隔离用户 hooks、MCP 与持久会话；工具验收仅允许 Read。

未在线验证：Factory API Key、等待真实令牌到期后的刷新、macOS keychain、所有模型和全部 Anthropic beta 功能。对应模拟测试不等同于真实服务验收。
