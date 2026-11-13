# DSH/OpenCode Go 峰谷调度：工作日准时停工

本功能可选。**默认未启用**，原有 WorkBuddy 不受影响。使用 `--offpeak-schedule` 注册后才会生效。
OpenCode Go 官方 DeepSeek V4.1 Flash 峰时（UTC）：工作日 01:00–04:00、06:00–10:00；
换算到北京/新加坡 UTC+8：**周一至周五 09:00–12:00、14:00–18:00**。周末全谷时。

官方依据：https://opencode.ai/v2/docs/console/go/ （若官方时间调整，需人工调整 JSON 并重启 MCP）。

## 安装

先确认无 DSH 活动任务；若存在，等任务完成。两台电脑分别执行：

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Git 同步失败" }

# 只预览，无实际安装
node .\scripts\manage.mjs --enable-dsh --offpeak-schedule

# 核对预览后启用（默认只读）
node .\scripts\manage.mjs --apply --enable-dsh --offpeak-schedule
node .\scripts\manage.mjs --verify
```

如果你之前的 DSH MCP **已经明确启用写入能力**，为保留它，在上面的启用命令后另外加 `--allow-write`；
不要为了日程功能意外开放写入权限。安装脚本不会改动原 WorkBuddy MCP、OpenCode Go API Key 或 DSH Profile。

安装器默认保留先前已启用的时段控制：以后即使再运行 `--enable-dsh`，也不会意外关闭它。
需要关闭时（无任务运行）：

```powershell
node .\scripts\manage.mjs --apply --enable-dsh --disable-offpeak-schedule
```

如果此前启用了写入，同样需要附加 `--allow-write` 以保留此权限。

多实例安装（`--dsh-instance`）时，每个命名实例都继承本次的 `--schedule-config`；安装器不提供“只给新实例关闭日程”的选项，不能用新实例绕过峰谷门禁。若原默认实例已启用日程而本次没显式关闭，新增实例会继续带日程。实例各自的硬停工只终止该实例拥有的子进程，不跨实例杀进程。完整多实例流程见 [multisession.md](multisession.md)。

注册完成后，**在没有正在运行的任务时**重新启动 Codex，让新的 MCP 进程加载设置。
在 Codex 里由真实 Sol Max 子代理调用 `get_dsh_schedule_status` 验证 `enabled=true`，
并查看 `phase`、`accept_new_tasks` 和 `hard_stop_at`。不要通过重复轮询消耗模型额度。

## 具体行为

1. 工作日 **08:50–12:00、13:50–18:00** 拒绝新的 DSH 派单（包含提前十分钟禁入）。
2. 在谷时正常接单；默认不接受「任务自身 `timeoutMs` + 1 分钟安全余量」可能越过下个峰时的任务。
3. MCP 本地计时器每 15 秒内核对系统时间；如果运行中的 DSH 到达峰时，尽力终止该桥接器**拥有的本地子进程树**。
4. 因日程停止的任务记录 `status=schedule_stopped`、`stop_reason=scheduled_peak`、执行回执和真实 Session ID（如果已经获得）；不能计为 completed。
5. 默认**不会在 12:00 / 18:00 自动恢复、重复派单或自动切换模型**。要续做，先核实 Git diff、日志、Session 状态和原任务终态，再明确批准下一阶段。
6. 运行开始时提供截至前 5 分钟尽量保存进度的提示；DSH Headless 不能保证运行中实时收到新指令，也不能保证原子检查点成功。

## 风险与边界

- 强制结束进程可能使当前写入、训练、回测或外部程序留在中间状态；这是**硬停工功能**，不是无损保存。
- 计时器依赖本机时间、MCP 仍在运行、Windows 未休眠；休眠时无法精确到点执行，唤醒后才会响应。
- Windows `taskkill /T` 只能尽力处理本机进程树，不能保证终止远端服务器/Slurm/GPU 后台作业。
- 修改 `config/offpeak.schedule.json` 的时间窗口后，需在无任务运行时重启 Codex 才能生效。
- 本版时区限定中国和新加坡（均 UTC+8，无夏令时）。`rejectTaskIfBudgetExceedsWindow` 可设置为 false，但增加峰时强制中断的风险。
- 仍遵守原有 Astra → 真实 Sol → DSH 调度链、写入授权与不回退规则。唯一例外是 `docs/hy4-fallback.md` 的显式授权预准入 HY4 策略；本机未部署/未验证时不得使用。本地定时器不是新的 AI 代理。
- 遇到峰时门禁、任务硬停或时段冲突，不让 Sol 或 Astra 自己代替 DSH 执行；也不通过新实例、改配置或通用日程绕过规避门禁。
