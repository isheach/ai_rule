# DSH 峰谷调度

在当前 DSH 会话说“本会话用峰谷模式 2”即可选用该模式。“关闭峰谷”和“开启峰谷”分别对应 1 和 3。各选项、设置工具和续跑边界见 [DSH 调度参考](../skills/multi-agent-dispatch/references/dsh.md#schedulemode-如何作用)。

## 日历与状态

- 默认日历为工作日 UTC+8 的 09:00–12:00、14:00–18:00。例行日历由注册或内置配置提供。启用日历时，DSH 在峰前十分钟关闭新任务准入，谷时检查任务预算及 60 秒余量。 [仓库日历](../config/offpeak.schedule.json) · [OpenCode Go](https://opencode.ai/v2/docs/console/go/)
- 默认和命名实例可通过注册参数 `--schedule-config` 指定日历。安装器 `--offpeak-schedule` 绑定仓库日历，`--disable-offpeak-schedule` 移除这条定制注册参数。单个会话仍独立选择是否应用日历。注册或日历文件变化后，在活跃任务结束时按宿主方式加载。
- 根池与 API 协调器各从所配池读取日历。两条来源共用池时，根会话的峰谷值也共用。用有效根上下文查看 `schedule.mode`、`phase` 和 `new_task_backend`。`accept_new_tasks` 表示 DSH 准入。
- 已启用的模式 2 或 3 到峰时由进程所有者尽力终止其 DSH 子进程树。结果记录 `schedule_stopped` 和 `scheduled_peak`，沿用原任务终态。提前保存由实际执行者在预算内处理，宿主休眠可能推迟检查。

## 模式 2 的峰时派发

用实际峰段的已批准新任务验收。核对 DSH 回执是否预留交接、Sol 是否使用已加载且能力相符的 WorkBuddy DSF、领取是否只有一次，以及原键下是否回填实际任务 ID、会话 ID 和终态。峰前窗口与不能在谷时预算内完成的任务应保留相应门禁。 [领取与回填步骤](../skills/multi-agent-dispatch/references/workbuddy-peak.md)

已授权的工作目录、论文输入和能力随任务沿用。WorkBuddy 缺失或无法覆盖原范围时，验收回执应指出峰时阻塞。谷时任务可以按所选日历继续使用 DSH。 [WorkBuddy 本机配置](workbuddy-project-entry.md) · [API Sol 接入](sol-coordinator.md)

## 模式 3 的预准入策略

原日历按 DSH 准入与硬停执行。只有在本机显式授权且满足官方 ACP 准入时，合格的新任务可以一次尝试 HY4。 [授权与决策回执](hy4-fallback.md)
