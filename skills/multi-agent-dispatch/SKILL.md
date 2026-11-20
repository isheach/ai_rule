---
name: multi-agent-dispatch
description: Coordinate agent selection and actual dispatch for coding or research using native Sol, DSH, WorkBuddy DSF, or HY4. Restore session choices, verify the execution host and target, reuse approved scope, and manage receipts and recovery.
---
<!-- ai-rule-managed: 2026-11-21.unified-dispatch-r2 -->

# 多代理调度

以当前生效的 AGENTS 为规则。Sol 的实际调用路径由本次协调来源决定，具体执行入口按当前会话选择。按需读取 [DSH 与峰谷设置](references/dsh.md)、[WorkBuddy DSF](references/workbuddy.md)、[HY4](references/hy4.md) 或 [模式 2 峰时交接](references/workbuddy-peak.md)。

## 1. 恢复选择并核实目标

- 从当前会话、可信交接或已验证根的持久记录恢复 `coordinator_mode`、`session_mode`、`scheduleMode` 及活动任务。依 AGENTS 处理明确切换与一次性覆盖。首次选择或切换时简短确认，随后按记录执行。
- 源的设置工具由 Astra 使用。在装有 `sol-coordinator` 的宿主中，按下方方法取得 `context`，以 `get_sol_coordinator_mode` 读回当前根。用户明确要在会话内切换时调用 `set_sol_coordinator_mode`，传 `mode: "api"` 或 `mode: "subscription"`。一次性 API 选择在本次的 `start_sol_coordination` 或 `run_sol_coordination` 传 `coordinatorMode: "api"`，一次性订阅选择直接走原生调度。
- 恢复的选择缺乏依据时先找原记录，仍不明确再澄清。保留活跃任务的原所有者和回执。DSH 的预准入例外见相应入口。
- 分开核实当前工具的执行宿主与任务目标。定位目标机器、账号或令牌及绝对路径，检查是否已有可达且获准的目标入口。沿用仍适用的证据，实际变更或失败时复核受影响项。Linux shell 是其自身的运行证据。以已核实的端点连接状态或原任务回执判断目标是否断连。原生派发使用实际宿主权限，按已加载的工具判断能力。
- 有相应入口时在现有授权内操作。缺少入口或选定的模型、认证、权限不可用时，报告具体阻塞与证据，按原归属继续能独立完成的源码修改和离线验证。Windows 部署从已核实的提交、绝对源码路径与实际本机身份开始。本机接续采用目标宿主实际支持的方式。

### 获取根会话上下文

使用 `dsh-root-pool` 的订阅 Sol 或使用 `sol-coordinator` 的 Astra，在自己的 Codex 执行宿主运行已注册入口旁的辅助程序。以下是 Windows PowerShell 示例，将 `$service` 设为实际所用服务名。

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $service = 'dsh-root-pool'
    $registration = codex mcp get $service --json
    if ($LASTEXITCODE -ne 0) { throw "无法读取当前 Codex 注册 $service" }
    $transport = (($registration -join [Environment]::NewLine) | ConvertFrom-Json).transport
    $arguments = @($transport.args)
    $position = [Array]::IndexOf($arguments, '--config')
    if ($position -lt 1 -or $position + 1 -ge $arguments.Count) { throw '未找到已注册的 --config' }
    $entry = $arguments[0]
    $config = $arguments[$position + 1]
    $absolutePath = '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)'
    if ($entry -notmatch $absolutePath -or $config -notmatch $absolutePath) { throw '注册未提供绝对入口及配置路径' }
    $helper = Join-Path (Split-Path -Parent $entry) 'cli.mjs'
    & ($transport.command) $helper context --config $config
}
```

使用同一注册的 `transport.command` 和 `args` 取得辅助程序及配置。把其 `context_ref` 作为工具的 `context`，过期后从同一宿主上下文刷新。辅助程序核实宿主线程及父链，保护上下文文件和完整注册内容。使用宿主实际线程证据，不手填根、子会话、lease，也不依赖 stdio MCP 获得线程变量。

## 2. 交接一份完整任务

交接实际执行宿主与已核实的目标入口、目标端的绝对 `cwd`、当前输入和范围、已批准的读写与原生命令、时间预算、限制、相关可共享记忆及验收标准。要求报告实际变更、命令和退出码、可核实结果和未完成检查。外部执行者自行使用其原生工具循环，Sol 在验收后才按需发出修订。

按所选入口传原任务的非秘密 `idempotencyKey` 和相应的权限参数。项目已有批准时，在支持的 `authorizationNote` 中引用批准来源。新独立工作或有意修订使用新键，原提交的回执查询使用原键。恢复和续跑步骤见各入口。

### Codex 订阅 Sol

1. Astra 创建或恢复与本次模型、推理档位相符的真实 Sol，核对宿主 agent ID、模型及档位。一次性模型覆盖只作用于新派发，只有用户明确要求持续沿用时才保存。
2. Sol 在自身上下文核实已加载的工具及对应目标。A 模式由 Sol 执行。外部模式由 Sol 实际调用所选 MCP 的提交、查询、等待、取消或修订接口。工具缺失或调用拒绝时回报 Astra，附实际执行宿主和调用结果。
3. Astra 用宿主原生 wait 等待真实 agent ID。一个 Sol 可以并行协调多个独立任务，分别保存各任务的回执及归属。

### OpenAI Responses API Sol

1. 新任务通过实际会话的 `sol-coordinator` 提交。首次检查或入口变化时，核对 `get_sol_coordinator_mode` 返回的就绪状态及目标执行入口。提交时传 `context`、`idempotencyKey`、`backend`（`DSH` 或 `WorkBuddy DSF`）、`goal`、`cwd`、`permissionMode` 与 `acceptance`。按需传 `constraints`、`contextSummary`、`timeoutMs` 及支持的任务能力和范围。写任务须传 `authorizationNote`。
2. DSH 首次转入另一个根池前，读取 `get_sol_schedule`。和当前会话已授权的选择不同时，通过 `set_sol_schedule` 应用该选择。两条链共用同根池且模式一致时直接派单。来源开关本身只设置协调来源。
3. 可用同步 `run_sol_coordination` 时由 Astra 等待结果。需要尽早取得协调 ID 或调用超时不足时，用 `start_sol_coordination` 及 `wait_sol_coordination`。查询、等待或取消使用 `get/wait/cancel_sol_coordination` 和原键，附所返回的 `taskId`。API Sol 在工具循环中实际派发、核对下游结果和使用受支持的原会话修订。保留 Responses ID、返回模型、推理档位、用量及真实执行回执。

## 3. 等到有结果

- 有明确任务预算、无需提前取 ID 或中途介入，且已核实宿主、客户端及服务的实际单次超时覆盖预算和启动收尾余量时，Sol 优先用支持阻塞的 `run`。时长本身不能决定改用异步。一次同步调用只需完成后验收。
- 需要提前取得 ID、途中观察或取消，或者实际工具超时不足或未知时，用受支持的 `start` 和 `wait`。已有 `start` 任务继续用原 ID 等待。传统 DSH、根池、官方 ACP 入口和 API 协调的单次 `waitMs` 上限为 `60000`，省略时为 `25000`。宿主允许时显式传 `60000`，较短限制内留通信余量并说明一次。WorkBuddy 按实际工具等待。
- 正常 `running` 且无须决策时直接续等，每项任务保持一个在途 wait。等待窗口届满仍沿用原截止预算。出现完成、失败、超时、阻塞、审批请求、实质里程碑或用户询问时及时处理，遵守更高优先级的更新要求。同步阻塞中的 Sol 与外部 Harness 各按其实际可用机制工作。

## 4. 验收、恢复与交接

- 核对实际变更、命令与退出码、结果及验收标准。DSH 的 `completed` 需要退出码 0 和 `final.reason.kind=completed`，业务验收还需任务证据。验证不足时，Sol 将必要修订交给原执行者。
- 分别记录源码或规则验证、目标机的结构检查、实际宿主的工具与代理就绪，以及获准的真实调用。普通 PowerShell 的代理状态只覆盖该 Windows 调用身份，API 计费验收以真实 Responses 回执及账单为准。
- 保留最小调用证据。订阅来源记录真实 Sol ID、宿主模型/档位和实际 MCP 调用归属，API 记录协调及 Responses 回执。两条链都保留执行任务 ID、根或实例、原键、实际后端和终态。宿主调用记录证明发起方，配置和报价目录分别作为路由及准入证据，实际计费查账单。
- 结果未知、找不到任务或发生断连时，沿原入口核实回执、所有权及进程。取消按授权交给原所有者并核对终态。保留锁和原进程，未核实旧任务前避免相冲突的新派单。
- 发现旧任务经 Astra 越级派发时，保留有效成果与原运行环境。停止新的越级派发，优先恢复原协调者，交接真实任务 ID、原键、cwd、回执、范围和带时间的状态。可安全访问时接续查询与验收，进程所有权无法接续时保留原进程等待并报告限制。下一项正常任务核对真实发起者。
