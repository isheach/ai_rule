<!-- ai-rule-managed: 2026-11-24.plan-b-r1 -->
# DSH 派发与日程

DSH 是全新会话的默认底层：GPT-6.2 Sol Max 协调，OpenCode Go DSF 执行。A 是原生 Sol 的显式模式；WorkBuddy DSF 是另一个显式底层，仅在用户选择或既有模式 2 峰时交接时使用，不是全新默认或自动回退。

## 选择入口

桥接器启动 DSH headless，预检查固定配置 `opencode-go / deepseek-v4.1-flash / max`。OpenCode Go 只提供推理服务及额度。DSH 任务由其原生工具循环完成。

| 入口 | 适用情况 | 提交和找回 |
|---|---|---|
| `dsh-root-pool` | 订阅 Sol 首选已加载且能验证当前根的根池 | 按 Skill 取得 `context`。用 `run_pool_task` 或 `start_pool_task`。`get/wait/cancel_pool_task` 用原键或归属该根的 `taskId`，引用过期可刷新。 |
| `dsh-opencode-go` 或 `dsh-opencode-go-<name>` | 订阅 Sol 收到明确服务选择，或本机未启用根池 | 首次或环境变化时读 `get_dsh_bridge_status` 的 `instance`、服务名、runtime 及活动任务。使用 `run/start_dsh_task` 及 `get/wait/cancel_dsh_task`，生命周期工具传原 `taskId`。 |
| `sol-coordinator` | API Sol 只使用所配根池 | Astra 按 Skill 交接，API Sol 通过同根的下游适配器派发和验收。 |
| 已明确配置的独立 ACP 组合入口 | 订阅 Sol 使用该入口既有的显式日历及预准入策略 | `run/start_routed_task` 提交，`get_routed_decision` 读决定，`get/wait/cancel_routed_task` 用原键找回受理任务。 |

同根可在已有根池的全局并发上限和 worker 容量内并发独立任务，每个任务使用自己的键；存在依赖时先等前置成果和验收。同一文件的修改须串行；确需并行时使用独立且获准的工作区，由单一所有者集成并检查冲突。不得复制 runtime 或另起未经批准的服务来绕过上限。传统实例各自串行，宿主可区分的不同实例可以并行。宿主无法区分同名工具时，使用支持的服务器作用域、独立 profile 或报告限制。根池已启用但上下文无法核验时，报告具体阻塞。首次、入口变化或异常时查看本机状态，日常续等无需重复探测。

## 任务参数和恢复

- 传 `prompt`、已批准的绝对 `cwd`、稳定的 `idempotencyKey`、适用的 `permissionMode` 和任务预算 `timeoutMs`。普通 DSH `timeoutMs` 省略时为 900000，上限 3600000。任务需要更长总时间时可由 Sol 规划有界阶段。
- 普通 DSH 的默认预设为 `workspace-write`。已配置的 `--read-only`、根池 `allow_write: false` 和任务 `permissionMode: "read-only"` 按所选入口生效。根池或 ACP 组合入口收到 `writes`、`writeScopes`、`commands` 时，把它们带入实际 DSH 任务书。在兼容的 WorkBuddy 与 HY4 交接中使用结构化范围。根池的显式 `workspace-write` 能力需要 `authorizationNote`，可引用已有授权。DSH 按 cwd、原生权限预设、任务书和宿主边界执行。任务若要求桥逐文件或命令强制校验，报告 DSH 入口的能力限制。
- 新任务由 DSH 生成会话 ID。继续 DSH 会话时使用原回执的 `session_id` 作为 `sessionId`，同 cwd、实例或根池 worker，使用新任务键。原实例仍占用时等待所有者。根池按原会话把请求路由到对应 worker。
- 失联后先找所属根或实例的原回执、锁和进程。传统接口的查询以 task ID 为准。不同实例或非所有者连接不能接管子进程。复制 runtime、拿其他实例的 ID 或清锁重跑会破坏任务归属。

## `scheduleMode` 如何作用

| 选项 | 谷时 | 峰前十分钟 | 实际峰时 |
|---|---|---|---|
| 1 无峰谷 | DSH | DSH | DSH |
| 2 峰时 WorkBuddy DSF | 预算通过后用 DSH | 报告门禁拒绝 | 新的独立任务使用 [一次性交接](workbuddy-peak.md) |
| 3 原峰谷 | 预算通过后用 DSH | DSH 门禁，可按 [授权的 HY4 预准入策略](hy4.md#dsh-预准入回退) | DSH 门禁，可按同一预准入策略 |

模式 2 和 3 使用注册或内置日历。内置峰时是工作日 UTC+8 09:00–12:00、14:00–18:00。DSH 谷时按任务预算加 60 秒检查。模式 2 的预算拒绝保持原状态，模式 3 按同一 HY4 规则判断是否有符合条件的预准入拒绝。在运行中遇峰时由 DSH 所有者应用硬停，`schedule_stopped` 是原任务终态。

- “关闭峰谷”选择 1，“开启峰谷”或“按原峰谷”选择 3。旧布尔选项 `false` 和 `true` 对应 1 和 3。每次只传当前 schema 支持的一种参数。
- 根池用 `set_pool_schedule` 持久化已验证根的 `scheduleMode`，用 `get_pool_status` 查有效状态。API 路径用 `set_sol_schedule` 与 `get_sol_schedule` 操作所配根池。更新应用于同根的运行中 DSH。
- 传统入口把选择保存在会话，提交传 `scheduleMode`，用 `set_dsh_task_schedule` 和原 `taskId` 更新该会话仍在运行的任务。用 `get_dsh_schedule_status` 查看活动或预览指定模式。旧提交参数是 `scheduleEnabled`，更新参数是 `enabled`。
- 独立 ACP 组合入口的 DSH 派发要求显式配置日历，使用原峰谷准入。独立传统 DSH 服务按已加载工具执行，其本身没有 HY4 适配器。
