# 实现、边界与验收记录

日期：2026-11-09。版本：0.1.0。

## 接口

本桥接器是无第三方依赖的 stdio MCP 实现，支持 initialize、ping、tools/list、tools/call 和请求取消通知。协议协商接受 2024-11-05、2025-03-26、2025-06-18；其他版本回报支持的 2025-06-18。并非通用 MCP SDK，未实现 HTTP transport/resources/prompts。

工具：

- get_dsh_bridge_status：本机状态，不发模型请求。
- run_dsh_task：提交并等到任务结束。
- start_dsh_task：提交并立即返回 task_id。
- get_dsh_task：读取回执。
- wait_dsh_task：事件式等待，最多 60 秒；没有额外模型调用。
- cancel_dsh_task：终止本进程拥有的任务，不按外部提供的任意 PID 杀进程。

示例任务参数：

```json
{
  "prompt": "只读分析当前测试目录；报告使用过的原生工具，不修改文件。",
  "cwd": "C:\\Users\\YOUR_USER\\AppData\\Local\\Temp\\dsh_smoke",
  "idempotencyKey": "smoke-001-r1",
  "permissionMode": "read-only",
  "timeoutMs": 120000
}
```

cwd 必须在本机存在；示例用户名必须替换。sessionId 只能取真实回执的 session_id。新任务默认新会话，恢复必须同一 cwd。
每个调用的 prompt 通过 stdin 传给 DSH，不拼进 shell 字符串，也不打印到进程命令行。

## 生命周期与监守

单用户默认 runtime 是 `%LOCALAPPDATA%\ai_rule\dsh`。独占锁阻止多个 Codex 会话同时在该 runtime 启动 DSH；一个活跃任务，超时 1 秒至 1 小时，默认 15 分钟。长于一小时的实验应拆分成有检查点的阶段，不保证跨断电持续运行。
相同幂等键和完全相同参数返回原任务，参数变化拒绝；有意修订用新键。
正在运行的 MCP 服务拥有 DSH 子进程；正常关闭、stdin 断开时请求清理，非正常崩溃/断电可能留下锁或进程。重启时不会按持久化 PID 自动杀进程，也不自动重跑。
Windows 取消使用系统 taskkill /T /F；强制退出或父进程已经结束时，子孙进程是否全部清理须本机核实，不能宣称 OS 级完全保证。
unknown_after_disconnect 表示本桥接器不拥有该活跃任务，可能另一个进程仍在运行，也可能原进程中断。检查 active.lock 与进程后人工决定清理，不能盲删锁。

DSH 在 Agent Loop 内负责执行及自己的智能监守；桥接器只做进程/超时/状态管理，不另启动 Sol、Luna 或 OpenCode。v0.1 没有独立并发智能监守代理，也没有持久后台调度服务。需要并发监守的特殊程序尚待单独实现和验收。
WorkBuddy 的既有任务管理原样保留，没有验证或更改其独立长任务监守能力。

## 真实结果与路由证据

每次新提交先用 DSH --help 和 --dump-config 检查本机能力以及 agent-default-model 配置，不进行付费探测调用。配置必须为 opencode-go/deepseek-v4.1-flash/max，否则明确失败。
没有编写自动 fallback。配置检查不是服务端模型证明，第三方插件/网关的路由并未被拦截审计；回执把 requested_route、configured_route 与 actual_route 分开，actual_route 未获得独立证据时保持 null，账单验证标记 unavailable。
只有退出码 0 且 final.reason.kind=completed 才标记 completed。final.text 是执行者报告，不是独立审计的业务测试结果。files_changed 未由桥接器审计时保持 null，而不是伪造空数组。

## 安全限制

read-only / workspace-write 是传给 DSH 的权限预设，--approval-policy never 表示拒绝需交互批准的操作，并非自动批准。没有 auto 或 full-access 模式。
本仓库没有实现自己的 OS 沙箱，cwd 不等于文件访问隔离。读权限、网络、凭据访问及 Windows sandbox 边界受 DSH/宿主配置影响；未通过本机负向权限测试前，不要开放敏感目录。
- AllowWrite 由人本机启用；authorizationNote 记录批准出处，但它不是密码学意义的授权令牌。真正的用户批准和宿主 MCP 审批仍不可跳过。
- 本桥接器不直接打开凭据文件、不修改持久凭据、不改全局审批。DSH 自身按用户已有设置读取凭据。
- 桥接器不记录 prompt 明文、tool 参数/完整结果或 thinking；保留有限最终答案与诊断，并做尽力脱敏。脱敏不是保证，DSH 自身会话文件仍由 DSH 管理。
- 输出最多 2 MiB，最终答案最多 60000 字符；超限取消，不会无限缓存。回执可能含项目细节，不提交 Git。
- 本地备份可能包含用户 config.toml 中的秘密，不上传。安装器仅合并标记块，不覆盖整个文件。

## 已执行的自动测试

开发容器：Linux，Node 22.16.0。`npm test` 使用 mock DSH，不访问付费 API。15 项测试全部通过：
路由解析、CLI 预检查、只读默认、写入双门槛、非法输入、脱敏、幂等合并、全局 override、MCP 重名拒绝、安装/回滚、回执/日志最小化/幂等、退出码与 final 双重判断、超时、取消/跨进程锁、stdio MCP 往返。

尚未验证：Windows PowerShell 5.1 真实执行、Windows 进程树清理、用户本机 DSH 0.2.2-rc.1 的 JSON 流、Codex 实际 MCP 连接、Go 账单归属、模型原生工具读写隔离、两个 WorkBuddy 通道回归、原生模型角色选择。

## 一手依据（查阅于 2026-11-09）

- Codex 全局 AGENTS 和 override：https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex Skill 位置：https://learn.chatgpt.com/docs/customization/overview
- Codex MCP：https://learn.chatgpt.com/docs/extend/mcp
- DSH Headless CLI/退出条件：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md
- DSH JSON 事件字段：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts
- MCP stdio：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

文档 master 可能继续变化。适配时检查实际本机版本，不自动升级用户已成功运行的 DSH 或插件。
