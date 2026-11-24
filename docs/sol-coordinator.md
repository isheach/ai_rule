# Sol 协调器

部署本机 `sol-coordinator` 后，可在 Codex 会话内选择订阅或受保护 OpenAI Responses API。全新默认底层是 DSH/OpenCode Go DSF，WorkBuddy DSF 仅在明确选择或既有模式 2 峰时交接时使用。Sol 可按同一来源调用 Terra 或 Luna 协作，主机操作、验收、绘图与图像生成或识别保留 Terra 专家路由。已配置 Antigravity 的协调器默认用 CLI 处理新文本任务。 [调度 Skill](../skills/multi-agent-dispatch/SKILL.md) · [反重力文本与模型配置](antigravity-text.md)

## 入口结构

`entryStructure` 独立于协调来源、A/外部执行模式和峰谷。默认 `astra` 沿原 Astra → Sol 交接，选择 `sol` 时仅在实际宿主提供真实直连能力的情况下直接进入 Sol；持久设置、单次覆盖、根池身份限制与调用者证据见 [会话入口结构](entry-structure.md)。切换不改变已受理任务的来源、后端、所有者或原回执。

## 执行宿主与目标机

先核实实际 shell 或 MCP 所在的执行宿主，以及要安装的 Windows 机器、Codex 用户身份及仓库路径。已有可达、获准的 Windows 入口时，可据此执行本机步骤。Linux shell 的结果只说明其自身的运行位置。只有云端源码入口时，可先完成 Git 修改和离线检查，Windows 注册、服务和实际宿主验收仍待目标机执行。判断目标是否断连以已核实的端点连接状态或原任务回执为据。现有入口和身份继续使用已核实的证据，变更或调用失败时复核受影响项。

## 固定源码修订

在运行 Codex 和 DSH 的普通 Windows 账户中操作。需要 Git、Node 22 或更新版本、64 位 Windows PowerShell Desktop 5.1（`powershell.exe`）及 .NET Framework 4.8。示例从现有仓库获取已审核的主分支版本。将 `$localRepo` 设为本地仓库绝对路径，`$sourceRef` 设为提供该版本的完整 Git ref。先从审核过的版本记录取得含 `scripts/setup-sol.ps1` 的完整提交 SHA。

```powershell
$solSource = & {
    $ErrorActionPreference = 'Stop'
    $profileRoot = [Environment]::GetFolderPath('UserProfile')
    $localRepo = Join-Path $profileRoot 'ai_rule'
    $repositoryUrl = 'https://github.com/isheach/ai_rule.git'
    $sourceRef = 'refs/heads/main'
    $expectedRevision = (Read-Host '输入已核对的完整提交 SHA').Trim().ToLowerInvariant()
    if ($expectedRevision -cnotmatch '^[0-9a-f]{40}$') { throw '需要完整的 Git 提交 SHA' }
    $sourceRoot = Join-Path $profileRoot "ai-rule-sol-$expectedRevision"

    if (-not (Test-Path -LiteralPath $sourceRoot)) {
        git -C $localRepo fetch --quiet --no-tags $repositoryUrl $sourceRef | Out-Host
        if ($LASTEXITCODE -ne 0) { throw '无法获取选定的 Git ref' }
        $fetchedRevision = git -C $localRepo rev-parse --verify FETCH_HEAD
        if ($LASTEXITCODE -ne 0 -or $fetchedRevision -cne $expectedRevision) { throw '获取的提交与已核对的 SHA 不同' }
        git -C $localRepo worktree add --quiet --detach $sourceRoot $expectedRevision | Out-Host
        if ($LASTEXITCODE -ne 0) { throw '无法创建固定版本工作树' }
    }
    $actualRevision = git -C $sourceRoot rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0 -or $actualRevision -cne $expectedRevision) { throw '本机源码版本与已核对的 SHA 不同' }
    $setupSol = Join-Path $sourceRoot 'scripts\setup-sol.ps1'
    if (-not (Test-Path -LiteralPath $setupSol -PathType Leaf)) { throw '此修订缺少 scripts/setup-sol.ps1' }
    [pscustomobject]@{ Root = $sourceRoot; Setup = $setupSol; Revision = $expectedRevision }
}
```

安装会引用这一固定工作树的绝对入口。保留它直至下一次注册已切到新源码。也可使用已有的干净源码副本，在命令块中将 `$sourceRoot` 设为其绝对路径，再核对 `HEAD` 和安装入口。

## 本机设置

同一普通用户窗口先预览，再应用。已有托管协调器使用其现有配置。可继承的标准 DSH 根池提供已有工作区与只读限制。首次设置需要明确工作区时，在下方参数表加入 `SolWorkspaceRoot`，填获准的现有绝对目录。传统 DSH 仍可沿用可继承的 JavaScript 入口、日历和只读限制，生成独立根池配置。没有可继承权限的生成配置默认只读。

新配置的模型与推理档位默认使用 `gpt-6.2-sol` 和 `max`，可通过 `SolModel` 和 `SolReasoningEffort` 指定。Terra 专家任务与 Sol 共用同一已选来源；API 来源固定使用 `gpt-6.1-terra` 和 `max` 并走受保护 Terra 客户端，订阅来源按宿主实际提供的 Terra 入口核对模型和档位。需定位已安装的 DSH JavaScript 入口时加入 `DshEntry`，使用自定义 Codex profile 时加入其绝对路径参数 `CodexHome`。使用 WorkBuddy 项目入口时，先为新工作树安装锁定的 SDK。 [项目入口](#项目入口)

```powershell
$setupArgs = @{ ExpectedRevision = $solSource.Revision }
& ($solSource.Setup) @setupArgs
```

核对预览中的源码、身份、配置、工作区与写入上限，再应用。使用 API WorkBuddy DSF 时，`workbuddy_configured` 表示协调配置含 WorkBuddy 入口，`workbuddy_sdk.installed` 表示标准项目入口目录中检测到锁定版本的 SDK。

```powershell
& ($solSource.Setup) @setupArgs -Apply
```

自定义入口或模型配置可使用 `SolCoordinatorConfig` 参数指定完整本机 JSON，代替从工作区生成配置。`pool_config` 指向匹配当前工作区和权限的根池配置。`state_dir` 与获准工作区、根池、上下文以及旧 DSH runtime 分开。 [Sol 配置模板](../config/sol-coordinator.example.json) · [根池配置](root-pool.md)

需要安装代理或首次设置密钥时，应用会通过本机 UAC 打开提升的 Windows PowerShell。安装服务时，提升进程校验该 Git 提交的安装载荷摘要，在管理员保护的 `Program Files` 临时目录准备并运行安装文件。调用者 SID 取自启动设置的普通用户身份，模型和推理档位取自计划应用的配置。需要在初始服务策略中固定 OpenAI 项目或组织时，分别传 `ProjectId` 或 `OrganizationId`。本机代理就绪后，应用在原普通用户身份下更新协调器注册及规则。

用户只在提升窗口中已安装的 `SolBroker.exe set-key` 交互提示内输入密钥。管理员检查与录入使用本机 IPC。日后轮换也从本机提升控制台运行已安装的命令。

```powershell
$brokerExe = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'AiRuleSolBroker\SolBroker.exe'
& $brokerExe set-key
```

仅需更新普通用户的既有协调器配置时，可使用下列 Node 入口。把 `$solConfig` 设为实际 JSON 的绝对路径。这一入口也可在 PowerShell 脚本受本机执行策略限制时管理普通用户注册。服务安装按 Windows 支持的本机机制执行。

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $manage = Join-Path $solSource.Root 'scripts\manage.mjs'
    node $manage --sol-coordinator-config $solConfig
    if ($LASTEXITCODE -ne 0) { throw '安装预览失败' }
    node $manage --apply --sol-coordinator-config $solConfig
    if ($LASTEXITCODE -ne 0) { throw '安装失败' }
    node $manage --verify
}
```

### 迁移现有机器

1. 保存活动任务的原 ID、幂等键和入口。受影响任务继续使用原服务，取得终态后再加载新 MCP。
2. 原配置只有旧 `api_key_env` 时，应用会在原 JSON 将它替换为 `"credential_source": "windows-broker"`。原配置使用 `project_env` 或 `organization_env` 时，先在本机核实原项目和组织 ID，并准备相应的 `ProjectId` 与 `OrganizationId` 参数。随后在原 JSON 中将旧环境变量引用替换为 `"credential_source": "windows-broker"`。保留原 `model`、`reasoning_effort`、`response_model`、`pool_config`、`state_dir` 和 `workbuddy`。自管 MCP 注册的旧 OpenAI 转发项需在本机移除。
3. 若曾经通过环境变量传递真实密钥，使用一把专用于代理的项目密钥完成本机交互录入。随后撤销旧密钥，清理实际用过的用户或机器环境变量及 MCP 转发项，再重新启动继承过旧环境的应用。密钥只通过本机交互提示录入。

### 独立凭据代理

`AiRuleSolBroker` 使用 `NT SERVICE\AiRuleSolBroker` 服务身份，并以该身份的 DPAPI CurrentUser 保存密钥。普通客户端只可查询状态和提交受限的 Responses 请求。同一获准 Windows 身份下的进程共享调用配额。Codex 和执行器日常以普通权限运行，服务程序和存储受本机管理员保护。 [凭据路径审计](implementation.md#api-sol-凭据路径)

受保护安装器为新装策略写入每小时 100 次上游请求上限，缺少 `requests_per_hour` 的旧策略仍为 24。每次最多 768,000 字节请求体与 64,000 个输出 token，上游超时 180 秒。协调配置中更低的限制继续生效。Sol、Terra 和 Luna 共用此配额，服务配额跨重启保留。最多并发三次上游请求，状态查询走独立管道。管理员可在受保护的 `%ProgramFiles%\AiRuleSolBroker\state\audit.jsonl` 查看时间、操作、结果和状态码。日志定长轮换，只记录调用元数据。

### 启用 Luna API

普通用户从已有 Sol broker 开始。首次安装 broker 按本机设置完成，再按下列命令预览并应用启用 Luna。应用会请求 UAC，保留原密钥、账户、项目、既有 Terra 策略和滚动配额。Terra 和 Luna 各用自己的启用命令。

```powershell
& ($solSource.Setup) -ExpectedRevision $solSource.Revision -EnableLunaApi
# 核对预览后应用
& ($solSource.Setup) -ExpectedRevision $solSource.Revision -EnableLunaApi -Apply
```

若服务正在运行，需要等待在途工作结束，在已授权的短维护窗口内为 apply 加 `-AllowBriefRestart`。若服务原来停止，升级保留该状态，服务按原方式运行时再核验。服务停止且普通账户无法读策略时，预览会显示额度未知，提升后的安装器根据实际策略处理。预览、升级和只读状态都不发送模型请求。

如果已有 `sol-coordinator` 注册仍指向旧固定工作树，等活动任务取得终态后，使用新工作树和原配置路径按普通用户注册步骤更新入口，并重新加载宿主。目标机已启用的 broker 沿用现有凭据。 [本机设置](#本机设置)

### API 配额

已有显式值（如 96）保留。只有用户授权并显式运行受保护升级才提高到 100，不会静默迁移，只接受提高、拒绝降低。沿用上文已核对的 `$solSource`：

```powershell
& ($solSource.Setup) -ExpectedRevision $solSource.Revision -EnableTerraApi -RequestsPerHour 100
# 核对预览后：
& ($solSource.Setup) -ExpectedRevision $solSource.Revision -EnableTerraApi -RequestsPerHour 100 -Apply
```

运行中的服务需在在途调用结束后显式加 `-AllowBriefRestart`，只进行一次短维护窗口停服；默认不停服。成功后用只读 `status` 核对 `requests_per_hour` 为 100；滚动记录和审计文件不会被重置。 [详细配额与 Terra 入口](../skills/multi-agent-dispatch/references/terra-api.md#共享配额与显式升级)

Terra 直接专家入口使用 `bridges/terra/protected.mjs` 和 `bridges/terra/cli.mjs`，模型为 `gpt-6.1-terra` 和 `max`。此入口只运行项目预注册的有限动作。直接专家入口和三模型协作的 API 调用都经同一 `bridges/sol/broker.mjs` 转发。 [Terra 受保护入口](terra-api.md)

## 验证和切换

1. **源码与安装结构**。核对预览中的源码和配置路径。应用后的 `rules_current: true` 与 `sol_coordinator.structure_valid: true` 表示规则及托管注册通过结构核验。
2. **本机与实际宿主就绪**。安装结果中的 `broker.ready: true` 或下方 `broker-status` 的 `ready: true` 表明该普通 Windows 调用令牌通过身份、密钥状态和模型策略检查。受影响任务结束后，按实际宿主支持的方式加载注册。通过 [调度 Skill](../skills/multi-agent-dispatch/SKILL.md#获取根会话上下文) 取得当前根上下文，在实际 Codex 会话调用 `get_sol_coordinator_mode`，核实 `source_configured: true` 和 `broker_status: "ready"`。普通 PowerShell 与宿主可能使用不同令牌。按实际返回的状态或错误定位加载、身份及代理问题。
3. **真实 API 请求**。远端项目权限、返回模型、用量和计费需要经获准的真实调用核验。安装、状态查询和来源切换均使用本机操作。设置流程记录 `live_model_call_performed: false`。

普通用户可以从其当前托管注册读取绝对路径，在任何目录检查代理。

```powershell
$registeredSol = & {
    $ErrorActionPreference = 'Stop'
    $registration = codex mcp get sol-coordinator --json
    if ($LASTEXITCODE -ne 0) { throw '未能读取当前用户的 sol-coordinator 注册' }
    $transport = (($registration -join [Environment]::NewLine) | ConvertFrom-Json).transport
    $arguments = @($transport.args)
    if ($arguments.Count -ne 3 -or $arguments[1] -ne '--config') { throw '当前注册不是标准 Sol 入口' }
    $solCli = Join-Path (Split-Path -Parent $arguments[0]) 'cli.mjs'
    [pscustomobject]@{ Command = $transport.command; Client = $solCli; Config = $arguments[2] }
}
& ($registeredSol.Command) $registeredSol.Client broker-status --config $registeredSol.Config
& ($registeredSol.Command) $registeredSol.Client luna-status --config $registeredSol.Config
```

`luna-status` 使用原协调配置。就绪时应返回 `ready:true`、`model:gpt-6-luna`、`reasoning_effort:max` 及 `confirm_luna_api`、`delegate_work`、`finish_coordination`。在实际宿主里用 `get_sol_coordinator_mode` 核对 `peer_api.luna`、`peer_api.terra` 和 `delegate_peer_available`。这些字段证明本机入口状态。

在实际 Codex 会话中说“本会话 Sol 主控切到 API”或“本会话 Sol 主控切回订阅”可设置当前来源。正在进行的任务继续由原协调来源和执行后端负责。选定入口不可用时按实际调用结果报告受阻的环节。

**真实验证会向 OpenAI 提交一个模型请求并产生计费用量。** 获得该付费验证的明确授权后，可运行下列命令检查 `verified`、`returned_model`、推理档位和 `usage`。

```powershell
& ($registeredSol.Command) $registeredSol.Client verify-api --config $registeredSol.Config --accept-api-charges
# 对获准的 Luna 诊断
& ($registeredSol.Command) $registeredSol.Client verify-luna-api --config $registeredSol.Config --accept-luna-charges
```

代理向官方 Responses 提交获准的任务和相关执行结果，使用 `store: false`。协调器保留模型、档位、响应与执行任务 ID 和可确认的用量。按原任务键查询回执。 [凭据路径审计](implementation.md#api-sol-凭据路径)

独立 API 请求使用所配置 API 项目的额度。ChatGPT 赠送 API 额度的资格和扣减规则以 OpenAI 说明及实际 API 账单为准。协调配置的 `max_total_tokens` 根据已返回的用量决定是否继续下一轮，最后一轮可能使合计超过阈值。可配的请求数、输出和时间限制约束此协调任务。 [API 赠额](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions) · [API 账单](https://platform.openai.com/account/billing/overview)

## Sol 调用 Terra 或 Luna

订阅来源由 Sol 自己使用宿主实际提供的 Terra 或 Luna 代理，交接父任务权限并等待原 agent ID。原生宿主适配代码中，`dispatchLayeredTask` 把 `delegatePeer` 交给 Sol 的 `coordinate`。它调用宿主提供的 `nativeTerra.dispatch` 或 `nativeLuna.dispatch`，二者按传入的父任务权限、`signal` 和截止时间执行并等待，返回实际 `status`、模型、档位与 `agent_id` 或 `task_id`，供父结果保存。

API 普通任务示例。在已授权付费协作时向当前根的 `run_sol_coordination` 传入下列字段。

```json
{
  "context": "<host-issued sol-coordinator context_ref>",
  "idempotencyKey": "<new stable task key>",
  "coordinatorMode": "api",
  "goal": "核对已有分析。由 Sol 把边界情况交给 Luna 检查，并验收整体结论。",
  "cwd": "<absolute approved project directory>",
  "permissionMode": "read-only",
  "capability": "workspace-read",
  "acceptance": "报告核对的输入、边界情况及可复核的结论。",
  "acceptPeerCharges": true
}
```

Sol 自己调用 `delegate_peer`，传 `peer`（`terra` 或 `luna`）、`goal`、`acceptance` 和 `contextSummary`。调用在原协调任务内等待，子任务可用父任务的实际执行入口、同样的读写、命令与剩余预算，原模型和执行归属按回执保留。Sol 依据协作结果验收父任务，`peer_results` 记录实际结果，Responses 和可计量用量随父任务保存。旧 broker 可继续普通 Sol 工作，新协作要等目标模型与工具就绪。

## WorkBuddy DSF

### 项目入口

在普通用户窗口为新的固定工作树安装它自己的锁定 SDK。每个工作树使用自己的 `node_modules`。沿用同一本机项目 JSON、WorkBuddy 安装、账户及已批准项目范围。

```powershell
npm.cmd ci --ignore-scripts --prefix (Join-Path $solSource.Root 'bridges\workbuddy')
if ($LASTEXITCODE -ne 0) { throw 'WorkBuddy SDK 安装失败' }
```

首次将项目入口接入 API Sol 时，将以下 `workbuddy` 对象写入完整的协调配置，按上方普通用户注册流程应用并载入。显式 WorkBuddy DSF 和模式 2 的实际峰时派发均可由这一连接执行；它不是全新默认底层。API 沿用本机项目 JSON 和工具实现，本次目录与权限还受协调器工作区和只读上限约束。 [项目配置](workbuddy-project-entry.md#项目配置)

```json
{
  "workbuddy": {
    "project_config": "<absolute-state-root>/workbuddy-project.local.json"
  }
}
```

把 `<absolute-state-root>` 替换为实际的获准绝对目录。本机项目入口已加载后，同一批准范围内换课题、论文、数据或实验脚本时，仅按任务交接输入及适用范围。协调器沿用已有项目及授权，任务范围可收窄。 [WorkBuddy 工具参数](../skills/multi-agent-dispatch/references/workbuddy.md#项目入口)

### 已有定制入口

按本机已核实的定制桥 stdio 入口和已批准 profile 设置。可将现有 `codex mcp get deepseek-v4-flash-workbuddy --json` 结果保存到变量，仅提取批准的 `transport.command`、`args`、`cwd` 和所需环境变量名称。将示例中的工具字段和 profile 替换成实际值。

```json
{
  "workbuddy": {
    "command": "<absolute-node-executable>",
    "args": ["<absolute-bridge-entry>"],
    "cwd": "<absolute-bridge-directory>",
    "arguments": {
      "task": "实际任务参数名",
      "cwd": "实际目录参数名",
      "profile": "实际权限参数名"
    },
    "profiles": { "read-only": "<authorized-profile>" }
  }
}
```

把占位符替换为已核实的实际绝对路径、参数名和 profile。

定制连接使用固定 `WB_MODEL=deepseek-v4-flash` 与 `WB_SKIP_PERMISSIONS=false`。状态默认字段是 `ready`、`model`，结果默认字段是 `status`、`model`、`task_id`、`session_id`、`answer`，可用 `status_fields` 和 `result_fields` 匹配原桥。可通过 `env_vars` 传递所需非 OpenAI 环境变量名称，通过 `arguments.session` 映射已验证的续跑参数。配置已有获准工作区可写能力时，使用对应的 `workspace-write` profile。该定制适配器使用默认能力及 profile，显式结构化文件或命令范围由项目入口处理。

用完整本机配置重新预览、应用、验证，等活动协调安全结束后载入。用一项获准任务查实际 tools/list、readiness、请求、回执和续跑能力。缺少可用 WorkBuddy 连接时，模式 2 的峰时任务报告阻塞。 [既有定制桥](../bridges/workbuddy/README.md)

## 使用、恢复与回滚

在 Codex 中说“本会话 Sol 主控切到 API”即可设置会话来源。需要单项覆盖时说“仅本次由 API Sol 主控”。选择、派发的工具参数和已有任务的恢复见 [调度 Skill](../skills/multi-agent-dispatch/SKILL.md#openai-responses-api-sol)。发生断连、超时或受理不明时，用原任务键、ID 和当前有效根上下文查原协调记录及下游状态。

暂时停用 API 时，先在需要的会话明确切回订阅 Sol；已受理任务仍用原 ID 等待或查询。若要彻底撤销部署：

1. 等已有 API 协调任务结束。由管理员在受保护的 `Program Files` 下独立取得并核对原提交的源码。用该副本中 `bridges\sol\broker\windows\install.ps1` 的绝对路径执行 `-Uninstall`。此操作会删除服务、代理程序、已保存的加密密钥、限额记录及代理审计文件。需留存的审计先由管理员保全。
2. 若这把 OpenAI 项目密钥也要停用，在 OpenAI 项目中撤销。卸载本机副本不会撤销远端密钥。
3. 如需恢复安装前的协调器注册，在原普通用户窗口对固定源码中的 `scripts\manage.mjs` 绝对路径执行 `--rollback`，传原安装输出的 manifest 绝对路径。按提示处理其后的本地修改，再重载宿主。使用回滚后的旧版时选择订阅 Sol。 [回滚步骤](../README.md#更新规则与回滚)
