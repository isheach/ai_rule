# 等待接口与排障

实际操作按 [调度 Skill 的等待步骤](../skills/multi-agent-dispatch/SKILL.md#3-等到有结果)。首次部署、配置变化或遇到超时再核实宿主的有效工具期限。

| 参数 | 意义 | 当前 DSH 值 |
|---|---|---|
| `timeoutMs` | 整项任务的截止预算 | 默认 900000 ms，上限 3600000 ms |
| `waitMs` | 一次异步等待的窗口，任务结束可提前返回 | 默认 25000 ms，上限 60000 ms |
| `tool_timeout_sec` | 注册中的单次宿主工具期限 | 安装器示例 3700 秒，使用本机实际生效值 |

Astra 对订阅 Sol 使用宿主原生 agent ID，对 API Sol 使用 `sol-coordinator` 的协调任务。Sol 按执行入口使用原任务回执。DSH `run_dsh_task` 和 `run_pool_task` 在服务内循环等待，收到终态后返回。WorkBuddy 的生命周期取决于实际加载的接口。

## 排障

| 现象 | 核实项 |
|---|---|
| 新的有界任务无法使用同步调用 | 检查宿主、客户端及服务单次期限能否覆盖任务预算和启停余量。采用当前期限支持的提交与等待。 |
| `wait` 正常返回 `running` | 单次窗口结束，按原 ID 和任务预算续等。 |
| 调用直接报超时、断连或 `unknown_after_disconnect` | 查原任务回执、所属根或实例、锁与实际进程。 |
| 只看到工具成功、缺少业务结果 | 查看执行终态、输出及验收证据。已受理工作用原协调者继续核实。 |
| 观察到上层重复状态和进度输出 | 从正常任务的调用记录检查 wait 参数和在哪些状态发出更新。 |

对比等待开销时记录由谁调用、提交形态、wait 次数与参数、终态、实际可得的上层用量。DSH 的内部推理用量独立计算。桥接器提供同步等待和事件式异步等待，实际模型调用次数取决于宿主处理工具返回的方式。

实现源在 [DSH MCP](../bridges/dsh/server.mjs)、[DSH 生命周期](../bridges/dsh/core.mjs)、[根池 MCP](../bridges/pool/server.mjs) 和 [API 协调 MCP](../bridges/sol/server.mjs)。 [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)
