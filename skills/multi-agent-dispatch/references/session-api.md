<!-- ai-rule-managed: 2026-11-24.plan-b-r1 -->
# 会话上下文、路由与 API 入口

本文按需供 `multi-agent-dispatch` 使用。实际 schema、已加载入口与宿主权限为准。不得用示例替代回执或授权。

## 设置协调来源

- 来源设置工具由当前结构中实际可用的宿主或获授权接手者使用；`astra` 入口可由 Astra 操作。在装有 `sol-coordinator` 的宿主中，按下方方法取得 `context`，以 `get_sol_coordinator_mode` 读回当前根。用户明确要在会话内切换时调用 `set_sol_coordinator_mode`，传 `mode: "api"` 或 `mode: "subscription"`。一次性 API 选择在本次的 `start_sol_coordination` 或 `run_sol_coordination` 传 `coordinatorMode: "api"`，一次性订阅选择直接走原生调度。

### 获取根会话上下文

使用 `dsh-root-pool` 的订阅 Sol 或实际使用 `sol-coordinator` 的宿主，在自己的 Codex 执行宿主运行已注册入口旁的辅助程序。以下是 Windows PowerShell 示例，将 `$service` 设为实际所用服务名。

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

### 公共路由字段与示例

`purpose` 由主机按用户请求显式判定，路由代码不做关键词推断；省略为 `general`。专家 `purpose` 为 `computer_operation`、`acceptance`、`writing`、`image_generation`、`image_recognition`。各入口的 schema 不相同：CLI 只读 `resolve`、`dsh-root-pool` 和 `sol-coordinator` 各有自己的已加载 schema；原有 CLI 小写别名 `dsh`、`workbuddy-dsf`、`terra` 继续有效。本节的 Antigravity 条件默认仅作用于配置了 `antigravity` 的 `sol-coordinator`，其他入口的显式 Antigravity 解析或交接不意味着已经执行。`sol-coordinator` 的 `start_sol_coordination`/`run_sol_coordination` 是提交入口；`backend: "Antigravity"` 只用于纯文本 writing，其他取值和只读解析以实际加载 schema 为准。一般工作省略 backend 得 DSH；配置 Antigravity 时新 writing 省略 backend 得 Antigravity，未配置的旧安装按原 Terra 规则，其他专家动作仍按 Terra 规则。显式 Terra writing 保留原能力和计费要求。专家显式传 DSH 返回 `DISPATCH_BACKEND_PURPOSE_CONFLICT`，WorkBuddy DSF 只用于一般工作，一般任务的 API HY4/A 返回既有 `API_BACKEND_UNSUPPORTED`。

只读 CLI 解析示例（不调用模型，不需凭据）：

```powershell
node bridges/dispatch/cli.mjs resolve --source subscription --purpose writing
```

其 JSON 中应可核对以下字段（省略其他字段）：

```json
{"source":"subscription","purpose":"writing","layer":"specialist","backend_source":"default","executor":{"backend":"terra","model":"gpt-6.1-terra","reasoning_effort":"max","transport":"native-terra"}}
```

订阅来源的 `dsh-root-pool` 的 `start_pool_task`/`run_pool_task` 对默认 Terra 专家任务返回 `native_handoff`；显式 Antigravity 只返回面向协调入口的 `not_dispatched` 交接，不伪造任务 ID、不调用模型。`resolve_layer_dispatch` 只返回解析计划。原生 Terra 需宿主真实提供 `gpt-6.1-terra`/max；API Terra 由受保护 Terra client 执行。

协调入口（subscription 或 API 来源）使用 `start_sol_coordination` 或 `run_sol_coordination`，两者共享 handoff。`context` 必填，另有必填 `idempotencyKey`、`goal`、`cwd`、`permissionMode`、`acceptance`。可选字段包括 `coordinatorMode`（`subscription|api`）、`backend`、`purpose`、`authorizationNote`、`constraints`、`contextSummary`、`timeoutMs`、`capability`（`default|text-only|workspace-read|workspace-write`）、`writeScopes`、`writes`、`commands`、`acceptTerraCharges`、`acceptPeerCharges`、`antigravityModel`、`acceptAntigravityUsage`、`entryStructure`。`start` 返回 `task_id`。用原 `idempotencyKey` 和该 `taskId` 调用 `wait_sol_coordination`。`run` 在单次调用内等待。`context` 必须来自实际宿主的 `node bridges/sol/cli.mjs context --config <ABS>` 的 `context_ref`。服务按父链、服务 purpose 和 TTL 重新核实，手填根、线程、lease 或标签无效。

保留的显式 Terra `run_sol_coordination` 写作示例（`start_sol_coordination` 使用相同的 handoff）：

```json
{
  "context": "<host-issued sol-coordinator context_ref>",
  "idempotencyKey": "<new stable key>",
  "coordinatorMode": "api",
  "backend": "Terra",
  "purpose": "writing",
  "goal": "根据提供的材料写作所需文档章节。",
  "cwd": "<absolute approved project directory>",
  "permissionMode": "read-only",
  "acceptance": "所需章节完整、准确并以文本返回。",
  "acceptTerraCharges": true
}
```

API 中显式 `backend: "Terra"` 或旧安装原路由的 `purpose:"writing"` 不要求 host capability，由受保护 Terra client 发真实 Responses。新任务只有 `acceptTerraCharges:true` 才进入该路径，缺失或 false 返回 `TERRA_BILLING_CONSENT_REQUIRED`，不查 status、不发送。若用户已为同一 API 项目作出明确且仍有效的计费授权，沿用该授权，后续直接传 true，不重复询问。`context`、`authorizationNote` 或调用者标签都不是计费授权。该布尔是每次新协调的显式同意，服务不另存已授权开关。

`computer_operation`、`acceptance`、`image_generation`、`image_recognition` 的 API Terra 路径只使用宿主实际注册的对应 `capabilities`：runtime 为每个已提供的能力生成一个无模型参数、至多执行一次的 bounded action。缺项返回 `DISPATCH_CAPABILITY_MISSING`，不伪造 GUI、桌面或图像后端。write-effect（`computer_operation`、`image_generation`）还要求 `workspace-write`。只读项不要求。保留的 Terra `writing` 不需要这些能力，使用上述受保护 API 路径。`acceptance` 的 Terra 验收 action 与 Sol 在一般协调中复核 executor receipt 不同，后者仍由 Sol 按 receipt 作 `finish_coordination` 判定。

### OpenAI Responses API Sol

以下 Astra 步骤适用于 `astra` 入口。`sol` 入口由实际宿主直接通过已获准且就绪的 `sol-coordinator` 调用 `run/start_sol_coordination` 并等待，不创建 Astra 作为前置或收尾；详细选择和能力边界见 [入口结构](entry-structure.md)。

1. Astra 通过实际会话的 `sol-coordinator` 提交新任务。首次检查或入口变化时，核对 `get_sol_coordinator_mode` 返回的就绪状态及目标执行入口。按上文 handoff 传 `context`、`idempotencyKey`、`goal`、`cwd`、`permissionMode`、`acceptance` 与按需的显式 `purpose`（省略为 `general`）。一般工作省略 `backend` 得 DSH，只有明确选择才传 `backend:"WorkBuddy DSF"`。已配置 Antigravity 时新 writing 省略 backend 走其纯文本入口并传 `acceptAntigravityUsage:true`；其他专家任务和保留的 Terra 写作按 Terra 路径传 `acceptTerraCharges:true`。按需传 `constraints`、`contextSummary`、`timeoutMs` 及支持的任务能力和范围。workspace-write 任务须传 `authorizationNote`。
2. DSH 首次转入另一个根池前，读取 `get_sol_schedule`。和当前会话已授权的选择不同时，通过 `set_sol_schedule` 应用该选择。两条链共用同根池且模式一致时直接派单。来源开关本身只设置协调来源。
3. 可用同步 `run_sol_coordination` 时由 Astra 等待结果。需要尽早取得协调 ID 或调用超时不足时，用 `start_sol_coordination` 及 `wait_sol_coordination`。查询、等待或取消使用 `get/wait/cancel_sol_coordination` 和原键，附所返回的 `taskId`。一般/协调 purpose 的 API Sol 在工具循环中实际派发、核对下游结果和使用受支持的原会话修订。专家 purpose 不走该 Sol 工具循环，而按实际 Terra 或 Antigravity 入口执行。对 OpenAI 路径保留 Responses ID、返回模型、推理档位、用量及真实执行回执；Antigravity 保留其实际 CLI 初始化与终态回执，不虚构 Responses ID。

### 由 Sol 调用 Terra 或 Luna

1. Sol 只交接协作目标、验收条件和相关可共享上下文。协作继承同一父任务的 `cwd`、`permissionMode`、`capability`、`writeScopes`、`writes`、`commands`、授权说明、约束与预算。三者执行已批准的读写和命令时使用同一权限边界。受理后使用原子任务 ID 与键恢复，协作代理自身不再派发模型协作。
2. 订阅来源由 Sol 自己在真实宿主 spawn `gpt-6.1-terra` 或 `gpt-6-luna`，档位为 `max`，沿用父任务权限，用原生 wait 等待原 agent ID。记录实际返回的模型、档位、ID 和任务结果。宿主未加载该代理或相应操作能力时报告受阻。
3. 在使用 `dispatchLayeredTask` 的订阅适配宿主，Sol 的 `coordinate` 接收 `delegatePeer({ peer, goal, acceptance, contextSummary, idempotencyKey })`。宿主按原授权调用对应的 `nativeTerra.dispatch` 或 `nativeLuna.dispatch` 并等待实际终态。同一个子键重用原工作，变更工作使用新键。回执随父结果的 `peer_results` 返回。
4. API 来源在已授权的父 handoff 传 `acceptPeerCharges:true`。用 `get_sol_coordinator_mode` 查看 `delegate_peer_available` 和 `peer_api.terra`、`peer_api.luna`。API Sol 在自己的 Responses 循环调用 `delegate_peer({ peer, goal, acceptance, contextSummary })`，等待结果返回并继续负责整体验收。需要实际执行时，协作模型通过同一个已授权的 DSH 或 WorkBuddy DSF 入口调用 `delegate_work`。检查父回执的 `peer_results`、Responses、执行记录及合计 `usage`。缺授权、缺能力或未知状态按实际结果报告。

### 由 Sol 调用 Antigravity 文本协作

一般任务中需要文字子任务时，原 Sol 可在用户已明确授权 Google 身份、计费及所发送上下文后自行委派，无需用户先手工拆任务。父任务的协调来源、权限、原执行者与预算保持不变；AGY 子任务仅接收获准的任务文本，不能使用文件、命令、电脑或图像动作。

API 父 handoff 显式传 `acceptAntigravityUsage:true`，可选 `antigravityModel` 指定配置别名；未指定时取该任务受理时的默认别名，接单后冻结。确认受保护 broker 的现有 `delegate_peer` 支持可用时，API Sol 调用 `delegate_peer({ peer: "antigravity", goal, acceptance, contextSummary })` 并等待结果。AGY 不要求 `acceptPeerCharges`；Terra/Luna 的 API 协作仍须原先的 `acceptPeerCharges:true`、用户授权与模型就绪。Google 调用不经 OpenAI broker；broker 只承担原 API Sol 的受保护协调接口。

订阅 Sol 可调用已加载的 `run/start_sol_coordination` Antigravity 写作入口，使用该子任务自己的稳定键并按原键查回执；或在宿主实际注入 `nativeAntigravity` 时调用 `delegatePeer({ peer: "antigravity", goal, acceptance, contextSummary, idempotencyKey })`。Sol 接收回执并负责父任务验收，缺能力或隔离证据时报告阻塞。

只读 `get_sol_coordinator_mode` 的 `peer_route_diagnostics` 可查 Terra/Luna 路由；已核实目标宿主可用 `node bridges/sol/cli.mjs luna-status --config <ABS>`，或一次 `peer-status` 获取协作路由诊断。两者不替代真实调用或 AGY 的 Google 配置与 `delegate_peer` 就绪检查。

### Terra 专家任务

1. 订阅来源：按宿主实际提供的 Terra 代理或专家入口核对模型、档位和工具。不要把 `gpt-6.1-terra` 的 API 入口当成订阅代理，也不要把任务分配当成工具已就绪。纯写作返回文本即可。动作任务先核对 CUA/图像工具的实际能力和批准范围，完成后关闭限定范围。
2. API 来源：任务通过 `start/run_sol_coordination` 的 `purpose` 和 `acceptTerraCharges:true` 提交。显式或旧路由的 Terra writing 直接由受保护 Terra client 发送，control/acceptance/images 只在对应 host capability 已提供时执行。Terra CLI 的只读 `status` 不计费。`verify-api` 与固定只读 `acceptance` 是显式诊断，必须带 `--accept-terra-charges`，且不能替代任务路径或 host acceptance capability。只有实际 response ID、模型、usage 和动作回执可作为成功证据。未就绪、未授权或缺 capability 时报告未完成，不启动订阅回退或改用环境密钥。
