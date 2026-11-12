# 低开销等待策略

规则修订：2026-11-10.low-overhead-wait-r3；0.3.0 多实例沿用本策略，不改变会话保持、真实 Sol 调度链、wait 参数上限或操作授权。

## 为什么调整

用户观察到 Sol 多次调用 wait_dsh_task，每次返回后又重述计划和“任务仍在运行”。现有桥接器没有因此重复启动 DSH，但工具返回可能让上层模型重新参与推理。问题不仅是状态检查频率，也包括没有新信息的重复分析与输出。

本次只更新 AGENTS.md、调度 Skill、README 和本说明。桥接器、安装器、MCP 注册、凭据、权限和运行中任务均不修改。0.3.0 的 DSH 多实例改动见 `docs/multisession.md`，不改变本策略的等待语义。

## 三个不同的等待层

| 等待者/对象 | 使用方式 | 边界 |
|---|---|---|
| Astra 等真实 Sol 子代理 | 宿主原生 wait，使用真实 agent ID | 不向 Sol 发重复催问，不直接查 DSH |
| Sol 提交可安全同步的有界 DSH 任务 | run_dsh_task | 一次调用，桥接器内部等待终态后返回 |
| Sol 等已启动或需要异步的 DSH 任务 | wait_dsh_task，传原 taskId | 正常 running 无需重复说明，异常要处理 |

不把 MCP task_id 当成原生 agent ID；不使用 shell sleep、重复读日志或另起模型代理替代正常等待。
DSH 内部执行和必要智能监守仍由 DSH/DeepSeek 承担，外部模式不使用 Luna。A 模式仍只有 Sol 自行执行且确需监守时使用 Luna。

## 同步优先，但必须核实超时

新任务有明确上限、不需要途中决策/观察或提前获取 task_id，且已确认实际宿主单次 MCP 超时足够时，优先 run_dsh_task。不要因为任务预计几分钟或十几分钟就机械地选异步。

区分三个参数：

- timeoutMs：整个 DSH 任务的截止预算，v0.3.0 默认 900000 ms、最大 3600000 ms。
- waitMs：一次异步等待的窗口，默认 25000 ms、最大 60000 ms；任务完成会提前唤醒，不必等满。
- tool_timeout_sec：宿主工具调用期限，安装器模板设为 3700 秒；真实值可能受本地配置、客户端或其他宿主限制影响。

同步调用须满足：实际有效的工具调用期限大于任务 timeoutMs 加启动预检查、返回结果与清理余量。不能单看模板就宣称 Work、CLI 等全部宿主均能长期阻塞。预算由任务需求决定，不为等待而盲目设为一小时或改写全局超时。

仅在首次使用、配置变化或遇到超时证据时核对必要的非敏感配置；不要每轮读取整个 config.toml、完整会话日志或凭据。宿主限制不明时先用异步路径，说明一次原因即可。
run 内部已有循环等待，不会每 60 秒把 running 回执返回给 Sol；不需要修改桥接器来使用它。工具描述中的 long work 提示不能替代上述超时判断。

## 何时保留异步

需要提前取得 task_id、中途状态可见性/取消，宿主阻塞超时不足或未知，或任务已经 start 启动时，保留 start + wait。

已启动任务继续用原 taskId 等待，不能取消重启、提交同样 prompt、制造新幂等键，或调用 run 把它转换为同步。run 是提交并等待接口，不接受 taskId 来附着。幂等机制也不应被用来为切换等待形式而重提在运行任务。

当前版本正常建议显式使用：

```json
{
  "taskId": "从真实 start 回执取得的 ID",
  "waitMs": 60000
}
```

这是工具参数示意，不是 PowerShell 命令，ID 必须来自已有任务。如果实际宿主期限小于 60 秒加通信余量，使用其允许的最长值并报告一次限制；不要传当前工具不支持的 300000 或 600000。新的任务是否改用 run，由下一次提交前的条件决定。

正常 running 且无须决策时，只续等；不反复总结，不增加 get/status，不逐次读取完整日志。窗口到期不是整个任务超时，不能因此自动重试任务。
对 unknown_after_disconnect、任务不存在、错误或异常立即返回，停止紧密轮询，按既有所有权/交接规则处理。工具断连不证明任务已停止，不可盲目重跑。

## 汇报规则

除更高优先级的宿主更新要求外，只在任务完成、失败、超时、明确阻塞、需要用户审批、出现实质里程碑或用户主动询问时汇报。用户要求固定进度节奏时遵守，但不要因此重复派单或无意义地分析未完成结果。

“又过去一个等待窗口”“原生工具次数从 7 到 8”“仍未返回业务结果”本身不构成里程碑。等待时不提前推断业务结论、不重复旧的验收思路。Sol 收到终态后统一技术验收；Astra 接收摘要和重大决策，不重复整套技术审查。

安静等待不是关闭错误处理，也不能忽视用户取消或权限请求。桥接器目前没有主动推送后唤醒模型的服务，不能宣称有这种机制。一次同步调用中上层不进行周期轮询，不代表 DSH 本身不消耗推理额度；异步返回也不保证上层完全没有模型调用。

## 两台电脑更新命令

先在 PowerShell 预览：

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Git 同步失败，请停止，不要强制覆盖。" }
node .\scripts\manage.mjs
if ($LASTEXITCODE -ne 0) { throw "规则预览失败，请停止。" }
```

本次远端变更仅为 AGENTS.md、skills/multi-agent-dispatch/SKILL.md、README.md、docs/waiting-policy.md；预览安装只涉及本机生效的 AGENTS 文件和 Skill。若出现额外 bridges/scripts 变更，先检查，不在活动任务期间盲目更新运行代码。

确认后安装：

```powershell
node .\scripts\manage.mjs --apply
if ($LASTEXITCODE -ne 0) { throw "规则安装失败，请停止。" }
node .\scripts\manage.mjs --verify
if ($LASTEXITCODE -ne 0) { throw "规则验证失败，请检查输出。" }
```

不要加 --enable-dsh 或 --allow-write。本次不重写 MCP 或写权限；安装器版本显示 0.3.0。--verify 的 true 只确认持久文件/注册项存在，不证明实际等待策略已经遵守，也不验证规则版本内容。
两台电脑各同步一次，电脑 B 不需要 WorkBuddy。不得为了本次规则更新重装 DSH 或重新登录。

有任务运行时不要重启 Codex/MCP。在原会话发送：

```text
本机规则已更新为 low-overhead-wait-r3。请 Astra 和当前真实 Sol 协调子代理分别重读生效的 AGENTS.md 与 multi-agent-dispatch Skill，保留会话模式、权限和现有任务。
已启动任务不取消、不重启、不重新提交；Sol 继续用原 taskId 等待，宿主允许时显式 waitMs=60000。正常 running 没有新变化就续等，不重复进度说明，不额外轮询。
后续有界且不需中途介入的任务，在确认宿主工具超时足够后优先 run_dsh_task。Astra 继续原生 wait 等 Sol，不直接查询 DSH。
有错误、阻塞、审批、实质里程碑或我的新指令时再处理；不要重复连接测试，不新增实验。
```

同步调用尚在阻塞时，协调者可能只能在工具返回后读取新规则；不要强制打断它来刷新。任务安全结束后再重启或新开会话核实启动加载。

## 手工行为验收（尚未执行）

| 场景 | 预期 |
|---|---|
| 新的有界任务，宿主超时足够、不需中途干预 | Sol 一次 run；桥接器内部等待，结束后验收 |
| 已有 start 任务正在执行 | 保留 ID 与进程，用原 wait，不重提 |
| 异步 running 无新信息 | 续等，不每轮输出进度说明，不夹杂 get/status |
| 单次 wait 窗口结束 | 不当作任务超时，不重新启动 |
| 宿主只能支持较短工具调用 | 采用有效限制内的等待，报告一次，不假称 60 秒一定可行 |
| wait 很快报 unknown_after_disconnect | 报告所有权/连接阻塞，不高速重复 wait |
| 完成/错误/审批/用户取消 | 及时处理，不被“安静”规则压制 |
| Astra 正等待 Sol | 原生 wait，不直接轮询 DSH |
| WorkBuddy 模式 | 只使用其实际接口，不假设支持 DSH 等待参数 |

本文所述的 r3 等待策略基于当时核对的等待循环与参数上限；0.3.0 多实例没有改变 wait 参数和 run 内部循环，也没有进行新的付费模型调用或测量 Token 降幅。后续从正常任务记录核实真实 MCP 发起方、run/wait 次数与参数、终态及可得的上层模型用量；不为验收而重跑既有研究。

## 核对依据

- `bridges/dsh/server.mjs`：run 在桥接器内部循环等待；wait 工具的默认值和上限。
- `bridges/dsh/core.mjs`：事件式 wait、任务预算和退出处理。
- `scripts/manage.mjs`：本机规则安装以及独立的 MCP 注册选项。
- Codex MCP 超时配置：https://learn.chatgpt.com/docs/extend/mcp
- Codex 指令加载：https://learn.chatgpt.com/docs/agent-configuration/agents-md

公开文档会继续变化；实际宿主行为与已安装工具 schema 优先，不凭文档假定当前会话具有不存在的功能。
