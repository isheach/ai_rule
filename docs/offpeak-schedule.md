# DSH 峰谷调度

新会话默认关闭峰谷调度。用户可以在 Codex 中说“本会话开启峰谷”或“本会话关闭峰谷”。

## 根池

协调者用当前已验证的上下文调用 `set_pool_schedule`，传 `enabled: true` 或 `enabled: false`。选择随本根会话持久化，适用于新派单和同根运行中的 DSH。用 `get_pool_status` 检查状态。关闭后，运行中的任务继续，原定时器会检查最新选择。更改生效前已因峰时停止的任务保持终态。其他根会话各自应用其选择。

## 默认和命名 DSH 服务

协调者把用户的选择保存在当前会话，并在 `start_dsh_task` 或 `run_dsh_task` 传 `scheduleEnabled`。切换时用 `set_dsh_task_schedule` 更新本会话尚在运行的原任务 ID。共享一个默认服务的不同会话分别传递各自的选择。桥接器使用任务 ID 定位拥有的子进程。没有活动任务时，指定的选择随该会话用于下次派单。用 `get_dsh_schedule_status` 查看该服务当前活动任务的状态。

注册参数 `--schedule-config` 指定日历，省略时用内置日历。安装器的 `--offpeak-schedule` 明确注册仓库日历，`--disable-offpeak-schedule` 移除定制注册路径。更改日历文件或服务注册后，等活动任务结束再重新加载。单个会话切换日程无需重启。

## 默认日历

- 工作日 UTC+8 **09:00–12:00、14:00–18:00** 为峰时，周末为谷时。启用后提前十分钟拒绝新任务。
- 谷时准入检查任务的 `timeoutMs` 加 60 秒余量。运行中到达峰时，子进程所有者尽力终止本机进程树。
- 因峰时停止的任务记录 `schedule_stopped` 和 `scheduled_peak`，不会自动恢复。提前保存提示由 DSH 自行处理。宿主休眠会推迟时间检查。
- 预准入 HY4 回退及工作区权限分别遵循现有授权。详见 [HY4 回退](hy4-fallback.md)。

日历来源见 [OpenCode Go 文档](https://opencode.ai/v2/docs/console/go/)。
