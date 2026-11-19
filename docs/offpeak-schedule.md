# DSH 峰谷调度

用户可以说“本会话用峰谷模式 2”或指定下表中的其他模式。选择独立于会话的执行后端，适用于 DSH 会话。新会话默认模式 1。

| 模式 | 谷时 | 峰前十分钟 | 实际峰时 |
|---|---|---|---|
| 1 无峰谷 | DSH | DSH | DSH |
| 2 峰时 WorkBuddy DSF | DSH，检查谷时预算 | 门禁拒绝新任务 | 新任务使用 WorkBuddy `deepseek-v4-flash` |
| 3 原峰谷 | 原 DSH 准入和谷时预算 | 原门禁和可选 HY4 回退 | 原门禁和可选 HY4 回退 |

“关闭峰谷”对应模式 1，“开启峰谷”或“按原峰谷”对应模式 3。旧参数 `false` 和 `true` 分别对应 1 和 3。DSH 运行中启用模式 2 或 3 都按原日历硬停，停止后的任务保持终态。曾由 DSH 或 WorkBuddy 受理的任务始终由原后端处理。

## 根池

协调者用当前已验证的上下文调用 `set_pool_schedule`，传 `scheduleMode: 1`、`2` 或 `3`。传 `enabled` 的旧调用仍有效。选择随本根持久化，适用于新派单和同根运行中的 DSH。用 `get_pool_status` 查看 `schedule.mode`、`phase` 和 `new_task_backend`。`accept_new_tasks` 仍表示 DSH 准入。切到模式 1 后，仍在运行的 DSH 继续运行。其他根的选项独立。

## 默认和命名 DSH 服务

协调者把选择保存在当前会话，并在 `start_dsh_task` 或 `run_dsh_task` 传 `scheduleMode`。切换时用 `set_dsh_task_schedule` 和原任务 ID 更新本会话仍在运行的 DSH。派单兼容旧 `scheduleEnabled`，更新兼容旧 `enabled`。每次只传一个选项。共享服务的不同会话各自传值。`get_dsh_schedule_status` 默认查看活动任务或服务默认状态，传 `scheduleMode` 可以预览指定模式。

注册参数 `--schedule-config` 指定日历，省略时用内置日历。安装器的 `--offpeak-schedule` 明确注册仓库日历，`--disable-offpeak-schedule` 移除定制注册路径。更改日历文件或服务注册后，等活动任务结束再重新加载。单个会话切换日程无需重启。

## 模式 2 的峰时派发

1. 使用本会话的正常 DSH 派单入口和稳定的 `idempotencyKey`。经过现有参数、权限、会话、锁和日历检查后，实际峰时的新任务返回 `status: "workbuddy_pending"` 和 `workbuddy_dispatch`。此时没有模型任务 ID。谷时已受理的任务、旧 DSH `sessionId`、锁冲突、权限拒绝和未知状态都不产生交接。
2. 由唯一的 Sol 协调者核对宿主当前加载的 `deepseek-v4-flash-workbuddy`。用其实际 `get_task_bridge_status` 和工具 schema 验证 ready、固定模型 `deepseek-v4-flash`、授权 profile 及原任务所需目录和权限。如果服务缺失、忙碌、认证失败、模型或权限不匹配，调用 `finish_workbuddy_dsf_dispatch` 将待派发记录置为 `unavailable` 或 `refused`，向用户报告具体阻塞。
3. 就在调用模型前，通过原 DSH 或根池入口调用 `claim_workbuddy_dsf_dispatch`，传原 `idempotencyKey`、回执的 `dispatchId`，根池还需要本根有效 `context`。桥会复查同一峰段。只有取得 `claimed: true` 和一次性的 `claimToken` 的协调者可以执行下一步。模式已改变、峰段已结束或领取不明时，读原记录。默认或命名入口的选择由 Sol 按会话保存，切出模式 2 时把本会话未领取的交接记为 `cancelled`。
4. 仍在回执的 `expires_at` 前时，由该 Sol 按实际 schema 调用一次原 WorkBuddy `run_workbuddy_task`，传原授权范围、任务和目录。使用 WorkBuddy 实际等待机制并保留同一后端。调用参数、profile 和能力随已安装桥接器核验。峰段在领取后、调用前已结束时，用原 token 回填 `refused`。
5. 用 `finish_workbuddy_dsf_dispatch` 和原 `claimToken` 回填实际终态及已返回的 `backendTaskId`、`backendSessionId` 和可共享答复。断连或受理不明时回填 `unknown_after_disconnect`，使用原回执追踪，只有核实原结果后才能补记终态。`get_workbuddy_dsf_dispatch` 可按原键读回。根池也可用 `get_pool_task` 按键查看。重放返回既有记录，重复领取不会得到 token。已领取的远程任务使用 WorkBuddy 实际支持的查询或取消，未领取的交接可回填 `cancelled`。

谷时的下一项独立工作正常用 DSH。若用户在模式 2 的实际峰段明确继续 WorkBuddy，且该桥公开续跑能力，派发时使用新键和 `workBuddyContinuationKey`（本根或实例内、同一目录的已完成交接键）。读取交接返回的 WorkBuddy 会话 ID，并按实际 WorkBuddy schema 续跑。缺少原会话证据或厂商续跑能力时报告阻塞。峰时普通 DSH 续跑使用原 `sessionId` 并遵守 DSH 的峰谷限制。模式切换和峰段结束都不会迁移或自动重跑已受理工作。

模式 2 的交接、实际工具调用和结果回填由真实 stdio 测试连接离线 DSF fixture 验证。部署时由 Sol 核验真实 WorkBuddy 工具，缺少该服务的机器仍可执行模式 1、3 和模式 2 的谷时任务。

## 默认日历

- 工作日 UTC+8 **09:00–12:00、14:00–18:00** 为峰时，周末为谷时。启用后提前十分钟拒绝新任务。
- 谷时准入检查任务的 `timeoutMs` 加 60 秒余量。运行中到达峰时，子进程所有者尽力终止本机进程树。
- 因峰时停止的任务记录 `schedule_stopped` 和 `scheduled_peak`，不会自动恢复。提前保存提示由 DSH 自行处理。宿主休眠会推迟时间检查。
- 预准入 HY4 回退及工作区权限分别遵循现有授权。详见 [HY4 回退](hy4-fallback.md)。

日历来源见 [OpenCode Go 文档](https://opencode.ai/v2/docs/console/go/)。
