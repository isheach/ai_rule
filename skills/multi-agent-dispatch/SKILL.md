---
name: multi-agent-dispatch
description: Hand off tasks from Astra to GPT-6.2 Sol Max or GPT-6.1 Terra Max and report the owner's result. Covers subscription or protected Responses API, default DSH/OpenCode Go DSF execution, and explicit WorkBuddy DSF, native A, or HY4 alternatives.
---
<!-- ai-rule-managed: 2026-11-23.astra-handoff-r1 -->

# 多代理调度

以当前生效的 AGENTS 为规则。全新独立会话默认订阅 GPT-6.2 Sol Max → DSH/OpenCode Go DSF；WorkBuddy DSF 是显式底层替代（既有模式 2 峰时交接除外）。主机操作/验收、写作、绘图或图像生成与识别交 GPT-6.1 Terra Max，来源与 Sol 相同。按需读取 [DSH 与峰谷设置](references/dsh.md)、[WorkBuddy DSF](references/workbuddy.md)、[HY4](references/hy4.md)、[模式 2 峰时交接](references/workbuddy-peak.md) 或 [Terra 专家入口](references/terra-api.md)。

## 1. 恢复选择并核实目标

- 从当前会话、可信交接或已验证根的持久记录恢复 `coordinator_mode`、`session_mode`、`scheduleMode` 及活动任务。独立新会话采用 AGENTS 表中的默认值；已有 A/外部模式、当前 `scheduleMode`（含 3）、来源、已受理任务和所有者继续有效，不得被新默认改写。依 AGENTS 处理明确切换与一次性覆盖。首次选择或切换时简短确认，随后按记录执行。
- 源的设置工具由 Astra 使用。在装有 `sol-coordinator` 的宿主中，按下方方法取得 `context`，以 `get_sol_coordinator_mode` 读回当前根。用户明确要在会话内切换时调用 `set_sol_coordinator_mode`，传 `mode: "api"` 或 `mode: "subscription"`。一次性 API 选择在本次的 `start_sol_coordination` 或 `run_sol_coordination` 传 `coordinatorMode: "api"`，一次性订阅选择直接走原生调度。
- 恢复的选择缺乏依据时先找原记录，仍不明确再澄清。保留活跃任务的原所有者和回执。DSH 的预准入例外见相应入口。
- Astra 只核实选择和使用交接入口所需的宿主、目标与授权信息。接手的 Sol 或 Terra 在自身宿主区分执行工具与操作目标，核实目标机器、账号或令牌、绝对路径和实际可用权限。沿用仍适用的证据，实际变更或失败时复核受影响项。Linux shell 是其自身的运行证据。以已核实的端点连接状态或原任务回执判断目标是否断连。
- 所选入口无法受理时，Astra 报告入口、模型、认证或权限的具体阻塞和证据。受理后的阻塞由接手者报告。保留原来源和入口，由原所有者继续能独立完成的源码修改和离线验证。Windows 部署从已核实的提交、绝对源码路径与实际本机身份开始。本机接续采用目标宿主实际支持的方式。

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

使用同一注册的 `transport.command` 和 `args` 取得辅助程序及配置。把其 `context_ref` 作为工具的 `context`，过期后从同一宿主刷新。辅助程序按宿主提供的 `CODEX_THREAD_ID` 在该宿主的 `CODEX_HOME/sessions`（默认 `~/.codex/sessions`）匹配 rollout，并在调用时重新核实根及父链。

保护上下文文件和完整注册内容。使用宿主实际线程证据，不手填根、子会话、lease，也不依赖 stdio MCP 获得线程变量。若当前会话报告 `unknown MCP server`，检查其已加载工具及本机注册。若辅助程序报告 `exact rollout metadata not found`，在能保存自身 rollout 并加载该注册的本机 Codex 会话中重新获取引用。普通 PowerShell 的 `broker-status` 只验证该进程的 Windows 令牌，实际宿主仍须用自己的引用调用 `get_sol_coordinator_mode`。

## 2. 交接一份完整任务

Astra 根据用户指令和已有上下文，明确交付目标、范围、授权和验收条件，一次交给实际的 Sol，或按专家路由直接交给 Terra。完成交接即进入等待。详细研究、业务资料核对和实施规划由接手者负责。已受理任务沿用原所有者和回执。

默认两层：GPT-6.2 Sol Max 负责研究、规划、派发和验收；底层默认 OpenCode Go DSF（`deepseek-v4.1-flash`、max）。WorkBuddy DSF 使用自己的 `deepseek-v4-flash`，只在用户明确选择或既有模式 2 峰时交接时使用，不是全新默认，也不是自动回退。

| 任务 | 中间层 | 底层或调用 |
|---|---|---|
| 一般编码、研究、工作 | GPT-6.2 Sol Max | DSH/OpenCode Go DSF；显式 WorkBuddy DSF 替代 |
| 主机操作/验收、写作、绘图或图像生成与识别 | GPT-6.1 Terra Max | 仅实际提供的 CUA/主机/图像工具；API Terra 仅有限预注册动作 |

- A 模式由原生 Sol 规划、执行、分析和自审，是显式保留的原生模式，不套用默认两层；只有 Sol 自己执行且确需额外智能监守时才使用 Luna Max。需要 Terra 专家时由用户明确选择，不静默改派。
- Terra 专家任务不默认改走 DSF 或 WorkBuddy，也不在订阅和 API 间自动回退。订阅来源只用宿主实际提供并已核对的 Terra 代理、CUA/主机工具或图像工具；未提供时报告能力不可用。
- 纯写作可直接返回文本，不要求工具动作。主机操作/验收、图像生成或识别只通过实际提供的 CUA/图像工具或项目预注册动作；证据取本地回执或调用记录，不取模型自述。限定范围的 CUA 工作完成、失败或取消后关闭该范围，不影响无关窗口、进程或任务。
- API Terra 固定使用 [Terra 专家入口](references/terra-api.md) 的 `bridges/terra/protected.mjs` 与 `bridges/terra/cli.mjs`。上游只经 `bridges/sol/broker.mjs` 的 `brokerCall` 到已安装 Windows 凭据代理；模型 `gpt-6.1-terra`、`reasoning.effort=max`。只调用宿主实际提供并已预注册的有限动作，模型只选动作名，不能传路径、命令、脚本或插件，`allowWrite` 默认关闭。不得声称有通用桌面、CUA 或图像驱动；未提供相应动作时报告不可用。

Astra 转交已知的执行宿主、已核实的目标入口与目标端绝对 `cwd`，以及当前输入、已批准的读写与原生命令、时间预算、限制和相关可共享记忆。Terra 任务写明需要的专家能力、来源、工具/动作范围、证据要求及限定范围 CUA 的关闭条件。Sol 据此规划，在 A 模式自行执行，在外部模式交给所选 Harness，要求其报告实际变更、命令和退出码、可核实结果和未完成检查。外部执行者使用自己的原生工具循环，Sol 根据验收结果按需交回原执行者修订。

按所选入口传原任务的非秘密 `idempotencyKey` 和相应的权限参数。项目已有批准时，在支持的 `authorizationNote` 中引用批准来源。新独立工作或有意修订使用新键，原提交的回执查询使用原键。恢复和续跑步骤见各入口。

### 公共路由字段与示例

`purpose` 由主机按用户请求的工作显式判定，路由代码不做关键词推断；省略为 `general`。MCP 的专家 `purpose` 枚举只接受 `computer_operation`、`acceptance`、`writing`、`image_generation`、`image_recognition`。backend 取值规则：仅 CLI 的只读 `resolve`（`bridges/dispatch/cli.mjs resolve --backend`）接受小写别名 `dsh`、`workbuddy-dsf`、`terra`；`sol-coordinator` 的只读 `resolve_layer_dispatch` 的 backend schema 只枚举显示拼写 `DSH`、`WorkBuddy DSF`、`Terra`、`HY4`、`A`；`dsh-root-pool` 的只读 `resolve_layer_dispatch` 的 backend schema 只枚举显示名 `DSH`、`WorkBuddy DSF`、`Terra`。`sol-coordinator` 的 `start_sol_coordination`/`run_sol_coordination` 是提交入口，不属于只读解析，其 backend schema 同样只枚举显示拼写 `DSH`、`WorkBuddy DSF`、`Terra`、`HY4`、`A`；`HY4`、`A` 虽在枚举中，但按既有执行限制不可执行。一般工作省略 backend 得 DSH；专家 purpose 省略 backend 得 Terra。专家显式传 `DSH` 返回 `DISPATCH_BACKEND_PURPOSE_CONFLICT`；WorkBuddy DSF 只能用于一般工作；一般任务的 API HY4/A 返回既有 `API_BACKEND_UNSUPPORTED`。

只读 CLI 解析示例（不调用模型，不需凭据）：

```powershell
node bridges/dispatch/cli.mjs resolve --source subscription --purpose writing
```

其 JSON 中应可核对以下字段（省略其他字段）：

```json
{"source":"subscription","purpose":"writing","layer":"specialist","backend_source":"default","executor":{"backend":"terra","model":"gpt-6.1-terra","reasoning_effort":"max","transport":"native-terra"}}
```

订阅来源的 `dsh-root-pool` 的 `start_pool_task`/`run_pool_task` 对专家任务返回 `native_handoff`，不伪造任务 ID、不调用模型；`resolve_layer_dispatch` 只返回解析计划，宿主据此启动真实的原生 `gpt-6.1-terra`/max。API 来源才由受保护 Terra client 执行。

API 入口使用 `start_sol_coordination` 或 `run_sol_coordination`，两者共享 handoff；`context` 必填，另有必填 `idempotencyKey`、`goal`、`cwd`、`permissionMode`、`acceptance`。可选字段包括 `coordinatorMode`（`subscription|api`）、`backend`、`purpose`、`authorizationNote`、`constraints`、`contextSummary`、`timeoutMs`、`capability`（`default|text-only|workspace-read|workspace-write`）、`writeScopes`、`writes`、`commands`、`acceptTerraCharges`。`start` 返回 `task_id`；用原 `idempotencyKey` 和该 `taskId` 调用 `wait_sol_coordination`；`run` 在单次调用内等待。`context` 必须来自实际宿主的 `node bridges/sol/cli.mjs context --config <ABS>` 的 `context_ref`；服务按父链、服务 purpose 和 TTL 重新核实，手填根、线程、lease 或标签无效。

`run_sol_coordination` 示例（`start_sol_coordination` 使用相同的 handoff）：

```json
{
  "context": "<host-issued sol-coordinator context_ref>",
  "idempotencyKey": "<new stable key>",
  "coordinatorMode": "api",
  "purpose": "writing",
  "goal": "根据提供的材料写作所需文档章节。",
  "cwd": "<absolute approved project directory>",
  "permissionMode": "read-only",
  "acceptance": "所需章节完整、准确并以文本返回。",
  "acceptTerraCharges": true
}
```

API 的 `purpose:"writing"` 不要求 host capability，由受保护 Terra client 发真实 Responses；新任务只有 `acceptTerraCharges:true` 才进入该路径，缺失或 false 返回 `TERRA_BILLING_CONSENT_REQUIRED`，不查 status、不发送。若用户已为同一 API 项目作出明确且仍有效的计费授权，沿用该授权，后续直接传 true，不重复询问；`context`、`authorizationNote` 或调用者标签都不是计费授权。该布尔是每次新协调的显式同意，服务不另存已授权开关。

`computer_operation`、`acceptance`、`image_generation`、`image_recognition` 的 API Terra 路径只使用宿主实际注册的对应 `capabilities`：runtime 为每个已提供的能力生成一个无模型参数、至多执行一次的 bounded action；缺项返回 `DISPATCH_CAPABILITY_MISSING`，不伪造 GUI、桌面或图像后端。write-effect（`computer_operation`、`image_generation`）还要求 `workspace-write`；只读项不要求。纯 `writing` 不需要这些能力，已按上述真实 API 路径执行。`acceptance` 的 Terra 验收 action 与 Sol 在一般协调中复核 executor receipt 不同，后者仍由 Sol 按 receipt 作 `finish_coordination` 判定。

新装前置：Node ≥22；实际可用的 Codex 宿主；默认 DSH 需要已安装且可运行的 headless 路由 `opencode-go`/`deepseek-v4.1-flash`/max 和匹配工作区的协调配置。WorkBuddy DSF 不是新装前置，只有本机 `workbuddy` 入口/项目已配置并显式选择时可用；未配置的 API 请求返回 `WORKBUDDY_NOT_CONFIGURED`，不回退 DSH。API 来源还需已安装受保护 broker/`sol-coordinator` 配置；订阅来源由宿主提供真实原生模型。

### Codex 订阅 Sol

1. Astra 创建或恢复与本次模型、推理档位相符的真实 Sol，核对宿主 agent ID、模型及档位。一次性模型覆盖只作用于新派发，只有用户明确要求持续沿用时才保存。
2. Sol 在自身上下文核实已加载的工具及对应目标。A 模式由 Sol 执行。外部模式由 Sol 实际调用所选 MCP 的提交、查询、等待、取消或修订接口。工具缺失或调用拒绝时回报 Astra，附实际执行宿主和调用结果。
3. Astra 用宿主原生 wait 等待真实 agent ID。一个 Sol 可以并行协调多个独立任务，分别保存各任务的回执及归属。

### OpenAI Responses API Sol

1. Astra 通过实际会话的 `sol-coordinator` 提交新任务。首次检查或入口变化时，核对 `get_sol_coordinator_mode` 返回的就绪状态及目标执行入口。按上文 handoff 传 `context`、`idempotencyKey`、`goal`、`cwd`、`permissionMode`、`acceptance` 与按需的显式 `purpose`（省略为 `general`）；一般工作省略 `backend` 得 DSH，只有明确选择才传 `backend:"WorkBuddy DSF"`；专家 purpose 省略 `backend` 得 Terra 并传 `acceptTerraCharges:true`。按需传 `constraints`、`contextSummary`、`timeoutMs` 及支持的任务能力和范围。workspace-write 任务须传 `authorizationNote`。
2. DSH 首次转入另一个根池前，读取 `get_sol_schedule`。和当前会话已授权的选择不同时，通过 `set_sol_schedule` 应用该选择。两条链共用同根池且模式一致时直接派单。来源开关本身只设置协调来源。
3. 可用同步 `run_sol_coordination` 时由 Astra 等待结果。需要尽早取得协调 ID 或调用超时不足时，用 `start_sol_coordination` 及 `wait_sol_coordination`。查询、等待或取消使用 `get/wait/cancel_sol_coordination` 和原键，附所返回的 `taskId`。一般/协调 purpose 的 API Sol 在工具循环中实际派发、核对下游结果和使用受支持的原会话修订；专家 purpose 不走该 Sol 工具循环，而按上文的 Terra 路径执行。保留 Responses ID、返回模型、推理档位、用量及真实执行回执。

### Terra 专家任务

1. 订阅来源：按宿主实际提供的 Terra 代理或专家入口核对模型、档位和工具；不要把 `gpt-6.1-terra` 的 API 入口当成订阅代理，也不要把任务分配当成工具已就绪。纯写作返回文本即可；动作任务先核对 CUA/图像工具的实际能力和批准范围，完成后关闭限定范围。
2. API 来源：任务通过 `start/run_sol_coordination` 的 `purpose` 和 `acceptTerraCharges:true` 提交；writing 直接由受保护 Terra client 发送，control/acceptance/images 只在对应 host capability 已提供时执行。Terra CLI 的只读 `status` 不计费；`verify-api` 与固定只读 `acceptance` 是显式诊断，必须带 `--accept-terra-charges`，且不能替代任务路径或 host acceptance capability。只有实际 response ID、模型、usage 和动作回执可作为成功证据；未就绪、未授权或缺 capability 时报告未完成，不启动订阅回退或改用环境密钥。

## 3. 等到有结果

- Astra 只等待所属 Sol 或 Terra 的结果。宿主代理用原 agent ID，API 协调采用同步返回或用原协调 ID 与键等待，直接专家工具沿其实际入口接收结果。Sol 在外部模式等待自己派出的原执行任务。等待期间的实现、下游状态处理和验收由接手者负责。
- 有明确任务预算、无需提前取 ID 或中途介入，且已核实宿主、客户端及服务的实际单次超时覆盖预算和启动收尾余量时，Sol 优先用支持阻塞的 `run`。时长本身不能决定改用异步。执行结果返回后由 Sol 验收。
- 需要提前取得 ID、途中观察或取消，或者实际工具超时不足或未知时，用受支持的 `start` 和 `wait`。已有 `start` 任务继续用原 ID 等待。传统 DSH、根池、官方 ACP 入口和 API 协调的单次 `waitMs` 上限为 `60000`，省略时为 `25000`。宿主允许时显式传 `60000`，较短限制内留通信余量并说明一次。WorkBuddy 按实际工具等待；API Terra 按其客户端/CLI 的实际同步边界等待，不套用 DSH 的等待上限。
- 正常 `running` 且无须决策时直接续等，每项任务保持一个在途 wait。等待窗口届满仍沿用原截止预算。出现完成、失败、超时、阻塞、审批请求、实质里程碑或用户询问时及时处理，遵守更高优先级的更新要求。同步阻塞中的 Sol 与外部 Harness 各按其实际可用机制工作。

## 4. 验收、恢复与交接

### Astra 接收结果

- 收到原 Sol 对本任务的明确完成回报，Astra 直接接受并据此汇报，或推进已授权的下一阶段。API 一般任务的完成确认来自 Sol 验收后返回的 `status: "completed"`。直接交给 Terra 的任务以所属专家入口的完成回报为准。汇报注明结果和检查来自谁。任务的研究、代码检查、测试和验收均由接手者负责。
- `running` 沿原入口续等。失败、超时、取消、阻塞或结果未知按实际状态处理。工具调用成功、下游进程退出或 agent 停止本身只说明该调用或进程的状态。
- 回报与已知任务或终态明显矛盾时，先请原 Sol 或 Terra 说明。只有接手者明确无法解决或请求上级决策时，Astra 才查看该问题。常规继续、修复和测试仍交原接手者处理。用户明确要求的只读调度审计和紧急停止按 AGENTS 的例外处理。

### 接手者验收和恢复

- Sol 依据原验收条件核对实际变更、命令与退出码及结果。DSH 的 `completed` 需要退出码 0 和 `final.reason.kind=completed`，业务验收还需任务证据。验证不足时，Sol 将必要修订交回原执行者。A 模式由 Sol 自审。可在原范围解决的事项由 Sol 推进。收尾时向 Astra 明确报告完成结论，或报告具体阻塞、待决事项和已完成的部分。
- Terra 负责核对实际模型、工具与结果，向 Astra 报告完成或阻塞。纯写作以实际返回文本为结果。动作任务以本地动作回执或调用记录为证据。限定范围 CUA 未关闭时报告未完成。关闭时确认未影响无关工作。API Terra 另保留真实 Responses 回执、动作回执和 usage。
- 接手者按任务范围分别记录源码或规则验证、目标机的结构检查、实际宿主工具与代理就绪，以及获准的真实调用。普通 PowerShell 的代理状态只覆盖该 Windows 调用身份，API 计费验收以真实 Responses 回执及账单为准。
- 各层保留其所属任务的最小调用证据。订阅来源记录真实 Sol/Terra ID、宿主模型/档位和实际 MCP 调用归属，API 记录协调及 Responses 回执。执行层保留任务 ID、根或实例、原键、实际后端和终态。宿主调用记录证明发起方，配置和报价目录分别作为路由及准入证据，实际计费查账单。
- Sol API 与 Terra API 共用同一 Windows 项目、broker 和每小时配额：新装 100，缺少 `requests_per_hour` 的旧策略为 24，已有显式值（如 96）保留，高于 100 的值不降低。只有用户授权并显式运行受保护升级才把低于 100 的值提高到 100，不会静默迁移，也不重置滚动记录。
- 结果未知、找不到任务或发生断连时，各层沿自己交接的原入口核实回执和归属，由原执行所有者核实下游进程。取消按授权交给原所有者并核对终态。保留锁和原进程，未核实旧任务前避免相冲突的新派单。
- 发现旧任务经 Astra 越级派发时，保留有效成果与原运行环境。停止新的越级派发，优先恢复原协调者。Astra 交接真实任务 ID、原键、cwd、回执、范围和带时间的状态。原协调者可安全访问时接续查询与验收，进程所有权无法接续时保留原进程等待并报告限制。下一项正常任务核对真实发起者。
