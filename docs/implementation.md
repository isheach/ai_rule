# 实现、边界与验收记录

日期：2026-11-12。版本：0.3.0。

## 接口

本桥接器是无第三方依赖的 stdio MCP 实现，支持 initialize、ping、tools/list、tools/call 和请求取消通知。协议协商接受 2024-11-05、2025-03-26、2025-06-18；其他版本回报支持的 2025-06-18。并非通用 MCP SDK，未实现 HTTP transport/resources/prompts。

工具：

- get_dsh_bridge_status：本机状态，不发模型请求；返回实例名、MCP 服务名、runtime、锁 owner 和活动任务，用于确认聊天选中的实例。
- run_dsh_task：提交并等到任务结束。
- start_dsh_task：提交并立即返回 task_id。
- get_dsh_task：读取回执；只接受所属实例的 task_id。
- wait_dsh_task：事件式等待，最多 60 秒；没有额外模型调用。
- cancel_dsh_task：终止本进程拥有的任务，不按外部提供的任意 PID 杀进程，也不跨实例取消。

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

cwd 必须在本机存在；示例用户名必须替换。sessionId 只能取同一实例真实回执的 session_id。新任务默认新会话，恢复必须同一实例、同一 cwd。
每个调用的 prompt 通过 stdin 传给 DSH，不拼进 shell 字符串，也不打印到进程命令行。

## 生命周期与监守

单用户默认 runtime 是 `%LOCALAPPDATA%\ai_rule\dsh`。命名实例使用 `%LOCALAPPDATA%\ai_rule\dsh-instances\<name>`，由 `--instance` 选择；默认服务名保持 `dsh-opencode-go`，命名服务名为 `dsh-opencode-go-<name>`。
每个实例各自持有一个独占 `active.lock`、一个任务回执目录、一个 requests 幂等域和一个 `sessions.json` 会话所有权索引。不同实例可以并行，同一实例一次只允许一个活跃 DSH 进程；独占锁的 owner、task_id 和实例名写入锁内容，供诊断。
实例名按小写 ASCII 和内部连字符校验，`default` 保留；runtime 经 realpath 与 Windows 大小写/分隔符归一化，`instance.json` 记录归属，同一物理路径不能注册两个实例。
相同幂等键和完全相同参数在同一个实例返回原任务，参数变化拒绝；不同实例的同名键互不相关。有意修订用新键。
正在运行的 MCP 服务拥有 DSH 子进程；正常关闭、stdin 断开时请求清理，非正常崩溃/断电可能留下锁或进程。重启时不会按持久化 PID 自动杀进程，也不自动重跑。
Windows 取消使用系统 taskkill /T /F；强制退出或父进程已经结束时，子孙进程是否全部清理须本机核实，不能宣称 OS 级完全保证。
unknown_after_disconnect 表示本桥接器不拥有该活跃任务，可能另一个进程仍在运行，也可能原进程中断。检查 active.lock 与进程后人工决定清理，不能盲删锁；非所有者不能取消、不能接管任务。
继续会话只接受本实例索引或本实例旧回执中的 session_id，且 cwd 必须一致。新任务由 DSH 生成 UUID；从另一实例复制 runtime 或伪造 session_id 会被拒绝，避免跨实例误接管。旧默认 runtime 中无实例字段的 v0.2.0 回执只允许默认实例读取，并在首次恢复时回填索引。
不同实例共享同一个 Windows 用户、DSH 凭据、模型额度和 DSH 会话存储；实例划分是任务队列/锁/回执隔离，不是 OS 沙箱、账户隔离或额度隔离。

DSH 在 Agent Loop 内负责执行及自己的智能监守；桥接器只做进程/超时/状态管理，不另启动 Sol、Luna 或 OpenCode。0.3.0 仍没有独立并发智能监守代理，也没有持久后台调度服务；多实例只增加任务域，不增加代理层。需要并发监守的特殊程序尚待单独实现和验收。
WorkBuddy 的既有任务管理原样保留，没有验证或更改其独立长任务监守能力。

## 真实结果与路由证据

每次新提交先用 DSH --help 和 --dump-config 检查本机能力以及 agent-default-model 配置，不进行付费探测调用。配置必须为 opencode-go/deepseek-v4.1-flash/max，否则明确失败。
没有编写自动 fallback。配置检查不是服务端模型证明，第三方插件/网关的路由并未被拦截审计；回执把 requested_route、configured_route 与 actual_route 分开，actual_route 未获得独立证据时保持 null，账单验证标记 unavailable。
只有退出码 0 且 final.reason.kind=completed 才标记 completed。final.text 是执行者报告，不是独立审计的业务测试结果。files_changed 未由桥接器审计时保持 null，而不是伪造空数组。

## 安全限制

read-only / workspace-write 是传给 DSH 的权限预设，--approval-policy never 表示拒绝需交互批准的操作，并非自动批准。没有 auto 或 full-access 模式。
本仓库没有实现自己的 OS 沙箱，cwd 不等于文件访问隔离。读权限、网络、凭据访问及 Windows sandbox 边界受 DSH/宿主配置影响；未通过本机负向权限测试前，不要开放敏感目录。
- AllowWrite 由人本机启用；authorizationNote 记录批准出处，但它不是密码学意义的授权令牌。真正的用户批准和宿主 MCP 审批仍不可跳过。
- 命名实例只隔离任务队列、锁、回执、幂等域和会话所有权；它们共享同一 Windows 用户、DSH 凭据、模型额度和 DSH 会话存储，不是账户隔离、额度隔离或 OS 沙箱。
- “仅新增命名实例”不会重写已有默认服务；默认已有的 `--runtime`、`--allow-write` 和自定义 `--schedule-config` 原样保留，新命名实例默认只读并继承该日程路径。要改默认策略须用不带 `--dsh-instance` 的独立安装命令；添加实例时夹带日程开关会被拒绝。`--verify` 明确只验证 managed 块，未管理服务列在 `unmanaged_dsh_services` 但不改写、不验证。
- 本桥接器不直接打开凭据文件、不修改持久凭据、不改全局审批。DSH 自身按用户已有设置读取凭据。
- 桥接器不记录 prompt 明文、tool 参数/完整结果或 thinking；保留有限最终答案与诊断，并做尽力脱敏。脱敏不是保证，DSH 自身会话文件仍由 DSH 管理。
- 输出最多 2 MiB，最终答案最多 60000 字符；超限取消，不会无限缓存。回执可能含项目细节，不提交 Git。
- 本地备份可能包含用户 config.toml 中的秘密，不上传。安装器仅合并标记块，不覆盖整个文件。

## 已执行的自动测试

2026-11-09 的历史开发容器（Linux，Node 22.16.0）中，`npm test` 使用 mock DSH，不访问付费 API，15 项测试全部通过：
路由解析、CLI 预检查、只读默认、写入双门槛、非法输入、脱敏、幂等合并、全局 override、MCP 重名拒绝、安装/回滚、回执/日志最小化/幂等、退出码与 final 双重判断、超时、取消/跨进程锁、stdio MCP 往返。

0.3.0 新增 `tests/multisession.test.mjs`，继续使用 `tests/mock-dsh.mjs`，覆盖：实例命名/路径拒绝、runtime 共享拒绝、不同实例子进程时间重叠、跨实例幂等域、错误域 get/wait/cancel、非所有者断连、旧默认回执与幂等回放、同实例同 cwd 会话续跑、峰谷/预算/硬停隔离、安装器新增/保留/删除、默认已有 `--runtime`/`--allow-write`/自定义 `--schedule-config` 不被静默重写、命名 MCP 身份状态。
本验收副本的 shell 在启动授权阶段因环境错误失败，**新增测试未获得执行结果**，不能声称通过；发布前必须在 Windows 和 CI 上运行 `npm test`。测试执行证据见私有验收记录，不随仓库发布。

尚未验证：Windows PowerShell 5.1 真实执行、Windows 进程树清理、用户本机 DSH 0.2.2-rc.1 的 JSON 流、Codex 实际 MCP 连接、同一宿主多个聊天的真实加载与双跑、Go 账单归属、模型原生工具读写隔离、两个 WorkBuddy 通道回归、原生模型角色选择。

## 一手依据（查阅于 2026-11-09）

- Codex 全局 AGENTS 和 override：https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex Skill 位置：https://learn.chatgpt.com/docs/customization/overview
- Codex MCP：https://learn.chatgpt.com/docs/extend/mcp
- DSH Headless CLI/退出条件：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md
- DSH JSON 事件字段：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts
- MCP stdio：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

文档 master 可能继续变化。适配时检查实际本机版本，不自动升级用户已成功运行的 DSH 或插件。
