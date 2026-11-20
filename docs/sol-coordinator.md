# 切换 Sol 协调来源

Codex 仍是主会话。每个新聊天的 `coordinator_mode` 默认 `subscription`，外部任务由 Codex 原生 Sol 协调子代理负责。`api` 使用本机 `sol-coordinator` MCP 调用独立 OpenAI Responses API；API Sol 规划、实际派单、审查执行回执，必要时按原授权要求同一后端续跑修订。Codex 只交接本轮需要的目标、范围和相关记忆摘要，并等待协调结果。

`coordinator_mode` 独立于 `session_mode` 和 DSH 峰谷选项。API 协调支持 DSH 和 WorkBuddy DSF。原生执行 A 和显式 HY4 由订阅路径支持；选择 API 同时要求这两种执行模式会收到可见的阻塞，原选择保留。DSH 模式 3 的已授权 HY4 预准入机制仍由根池判定。

## Windows 安装

使用现有 Codex 和已配置 DSH 的 Windows 账户。Node 22 是本仓库的最低要求。进入实际的本机克隆目录，下方以 `$env:USERPROFILE\ai_rule` 为例。将工作区填为实际授权的已存在目录。

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Git 同步失败" }

$sol = @{
    SolWorkspaceRoot = 'D:\Projects\approved'
    SolModel = 'gpt-6.2-sol'
    SolReasoningEffort = 'max'
}
.\scripts\install.ps1 @sol
.\scripts\install.ps1 -Apply @sol
.\scripts\install.ps1 -Verify
```

如果 PowerShell 策略限制脚本，则使用对应 Node 命令。

```powershell
$solArgs = @('--sol-workspace-root', 'D:\Projects\approved', '--sol-model', 'gpt-6.2-sol', '--sol-reasoning-effort', 'max')
node .\scripts\manage.mjs @solArgs
if ($LASTEXITCODE -ne 0) { throw "安装预览失败" }
node .\scripts\manage.mjs --apply @solArgs
if ($LASTEXITCODE -ne 0) { throw "安装失败" }
node .\scripts\manage.mjs --verify
```

预览只读取本机配置。应用只增加托管 `sol-coordinator` 注册和缺少的本机配置，同时更新现有规则与 Skill。旧 DSH、WorkBuddy、HY4、Codex profile 和运行目录继续使用原配置。已有 `dsh-root-pool` 且工作区及只读限制相符时，API 协调器使用同一个根池配置；原来只有默认 DSH 时，安装器沿用其 JavaScript 入口、日历和只读限制，为 API 协调创建独立的根池配置。若本机未记录入口且自动检测失败，可显式传 `-DshEntry`。原先由命名 DSH 接手的任务继续使用该实例。

如安装器提示自定义注册无法安全继承，可编写显式本机 JSON 并用 `-SolCoordinatorConfig` 安装。`pool_config` 指向现有兼容根池配置，或使用根池示例创建批准范围内的配置。将绝对路径与当前机器匹配，并沿用现有更严格的权限。`state_dir` 与批准工作区、根池、上下文目录及旧 DSH runtime 物理分离。使用以下命令预览、应用和验证。

```powershell
$solConfig = 'D:\ai-rule-state\sol-coordinator.local.json'
.\scripts\install.ps1 -SolCoordinatorConfig $solConfig
.\scripts\install.ps1 -Apply -SolCoordinatorConfig $solConfig
.\scripts\install.ps1 -Verify
```

显式配置模板及根池配置。 [Sol 配置示例](../config/sol-coordinator.example.json) · [根池设置](root-pool.md)

`-Verify` 中 `sol_coordinator.structure_valid: true` 确认安装器管理的注册、变量名及本机配置文件通过结构校验。首次新增注册后，在现有任务安全结束时按宿主支持的方式加载，再在新会话确认 `codex mcp list` 中有 `sol-coordinator` 并且工具可用。切换来源发生在会话内，已加载后两种来源可随时切换。

## 设置 API 环境并执行一次真实验证

OpenAI 官方模型目录列出 `gpt-6.2-sol` 及 `max` 推理档位。每台机器仍要用自己的 API 项目验证模型访问、响应模型和实际工具调用。项目密钥由 Windows 进程环境转发。安装器只在 `config.toml` 记录 `env_vars` 的变量名；凭据留在启动 Codex 的环境。 [OpenAI 模型目录](https://developers.openai.com/api/docs/models) · [Codex MCP 环境配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

如需在每次启动时自动载入，在 Windows 的“编辑账户的环境变量”中添加当前用户的 `SOL_OPENAI_API_KEY`。从新环境完全重启 Codex 及其父进程，例如 VS Code。也可以在准备启动 Codex 的同一个 PowerShell 中临时输入，下方 `Read-Host` 只影响该窗口和随后从它启动的进程。使用定制 `CODEX_HOME` 时，按实际宿主配置定位文件。

```powershell
$key = Read-Host 'OpenAI API key' -AsSecureString
$env:SOL_OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $key).Password
Remove-Variable key

$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$solConfig = Join-Path $codexDir 'ai-rule-sol\coordinator.local.json'

# 这一步会真正调用 Responses API 一次，产生 API 用量。
node .\bridges\sol\cli.mjs verify-api --config $solConfig
```

如使用显式配置，替换上面的 `$solConfig`。验证成功时检查 `verified`、`returned_model`、`reasoning_effort` 和 `usage`。使用已核实的模型快照时，可在配置里明确设置 `response_model` 来匹配实际响应。项目或组织需要额外请求头时，可在 `openai` 中配置 `project_env` 或 `organization_env`，然后用同一个配置路径重新应用注册以转发新增变量名。模型不符、认证失败、限流、错误或断连会停止当前 API 协调；选择保留，后续渠道由用户明确决定。

API 协调器向 `https://api.openai.com/v1/responses` 发送任务交接、模型工具调用和本轮验收所需的执行结果，显式请求 `store: false`。交接只含批准用于该任务的内容，避免加入私有日志、凭据和完整会话历史。本机回执记录响应和工具调用标识、下游真实任务 ID、终态及返回的用量；结果或用量未知时按未知呈现。

符合资格的 ChatGPT 赠送 API 额度适用于已关联的 API 组织内的独立 API 请求。OpenAI 先使用赠送额度，赠额用尽时可扣减该组织的已购余额。赠额政策排除 Codex 自身的 API key 用法。`max_total_tokens` 根据已返回的用量判断是否继续下一轮，最后一轮的输入和输出可能使累计用量超过阈值。请求次数、单次输出和时间限制用于控制协调任务，最终费用和余额以 OpenAI 账单为准。 [赠额使用规则](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions) · [API 账单](https://platform.openai.com/account/billing/overview)

## 使用 WorkBuddy DSF

### 项目入口

先完成本机 WorkBuddy 项目配置。使用显式 WorkBuddy DSF 或模式 2 实际峰时派发时，`coordinator.local.json` 的 `workbuddy` 对象指向订阅入口使用的同一本机 JSON。API Sol 会使用同一实现和项目授权检查，并传递原任务的权限及更窄的范围。DSH 根池也执行自己的工作区和日程检查。 [WorkBuddy 项目入口](workbuddy-project-entry.md)

```json
{
  "workbuddy": {
    "project_config": "D:\\ai-rule-state\\workbuddy-project.local.json"
  }
}
```

将该 `workbuddy` 对象写入现有协调配置，用 `-SolCoordinatorConfig` 指向完整的协调配置，预览、应用并验证。等该入口的活动任务结束后，按宿主支持的方式加载协调器配置一次。之后 API Sol 用原项目范围，即可派同一项目内新的论文、脚本或数据任务。写任务的 `authorizationNote` 可以引用既有项目授权，任务的 scope 只在该授权下收窄。

### 已有定制入口

现有定制 WorkBuddy DSF 可继续使用以下配置。先确认原桥支持本机 stdio 连接和当前 profile，再将 `codex mcp get deepseek-v4-flash-workbuddy --json` 解析到变量，只使用已批准的 `transport.command`、`args`、`cwd` 和需要转发的环境变量名。保留原注册中的实际路径、参数、权限及 profile。绝对命令路径应指向 Windows 可执行程序。

按原桥实际 `get_task_bridge_status`、`run_workbuddy_task` 的工具定义与回执字段填写以下映射。示例字段和 profile 必须替换为机器上已存在、经过授权的值。`env_vars` 可省略；如需转发环境变量，填写名称。适配器固定 `WB_MODEL=deepseek-v4-flash` 和 `WB_SKIP_PERMISSIONS=false`。

```json
{
  "workbuddy": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["D:\\WorkBuddyBridge\\server.mjs"],
    "cwd": "D:\\WorkBuddyBridge",
    "arguments": {
      "task": "实际任务参数名",
      "cwd": "实际目录参数名",
      "profile": "实际权限参数名"
    },
    "profiles": { "read-only": "actual-authorized-profile" }
  }
}
```

默认状态字段是 `ready` 和 `model`，结果是 `status`、`model`、`task_id`、`session_id`、`answer`。需要适配字段名时使用 `status_fields` 与 `result_fields`。如原桥公开续跑能力，`arguments.session` 填实际会话参数；仅在返回同后端原会话 ID 且本轮满足准入时续跑。授权工作区可写时，可在 `profiles` 配置现有 `workspace-write` profile。对无法原样满足的权限或 profile，任务在可见的阻塞处停止。

将 `workbuddy` 对象加入现有协调配置，指定同一路径重新预览、应用并验证。在活动协调结束后按宿主支持方式加载一次。首项本机验收选择批准目录和真实只读 profile，核对任务回执及 `deepseek-v4-flash`。缺少有效 WorkBuddy 配置时，模式 2 的实际峰时交接会报告不可用。谷时按原 DSH 门禁执行。 [WorkBuddy 桥接器](../bridges/workbuddy/README.md) · [DSH 峰谷模式](offpeak-schedule.md)

## 在 Codex 聊天中切换

| 聊天表达 | 效果 |
|---|---|
| 本会话使用 DSH，Sol 主控切到 API。 | 新任务由 API Sol 协调，执行模式选择 DSH。 |
| Sol 主控切回订阅。 | 后续任务使用 Codex 原生 Sol，当前执行模式继续沿用。 |
| 仅本次由 API Sol 主控，继续采用 DSH，只读分析当前项目。 | 本次用 API 协调，会话设置继续沿用原值。 |
| 仅本次由订阅 Sol 主控。 | 这个任务使用 Codex 原生 Sol，后续沿用会话的来源选项。 |
| 本会话使用 WorkBuddy DSF，Sol 主控切到 API。 | 使用已配置并通过状态检查的 WorkBuddy DSF。 |

已派发任务保持自己的协调器、后端、工作区和原幂等键。工作区与任务授权依次从宿主交接，API 模型只能在已有范围中派单。对启动、恢复、API 回执的验收，使用该协调任务的原 ID 和幂等键；订阅子代理则使用宿主的原生 agent ID。切换峰谷和切换来源各自独立，启用原日历可以按既有规则影响已运行的 DSH。

## Codex 工具调用与恢复

在会话自己的宿主 shell 中，从已注册的入口取得本地短期 `context_ref`。辅助程序读取宿主 rollout 的首行会话元数据，核验当前根会话或子代理父链。stdio 调用只收到 opaque 引用；刷新时由同一个宿主会话重新签发。

```powershell
$registration = codex mcp get sol-coordinator --json | ConvertFrom-Json
$entry = $registration.transport
$pos = [Array]::IndexOf($entry.args, '--config')
if ($pos -lt 0 -or $pos + 1 -ge $entry.args.Count) { throw "找不到已注册的 --config" }
$helper = Join-Path (Split-Path -Parent $entry.args[0]) 'cli.mjs'
& $entry.command $helper context --config $entry.args[$pos + 1]
```

把 `context_ref` 作为 `context` 传入 MCP。`get_sol_coordinator_mode` 查询当前根的来源，`set_sol_coordinator_mode` 以 `mode: "api"` 或 `mode: "subscription"` 更新后续任务。一次性 API 覆盖在 `start_sol_coordination` 或 `run_sol_coordination` 中传 `coordinatorMode: "api"`。API 任务需要稳定 `idempotencyKey`、`backend`、`goal`、绝对 `cwd`、`permissionMode` 和 `acceptance`。写任务的 `authorizationNote` 说明适用授权，可引用已有项目授权。

从默认或命名 DSH 服务切到 API 后，首项 DSH 任务开始前用 `get_sol_schedule` 核对当前根池。如果这个聊天已有可信的峰谷选择且与池中的值不同，用 `set_sol_schedule` 把该选择带入当前根池。已共用根池且模式一致时直接沿用。继续原传统 DSH 服务时，派单仍传当前会话已有 `scheduleMode`。只切换来源时，先执行来源工具，峰谷设置依据本会话已经授权的选择。

工具可在受支持的超时内同步 `run_sol_coordination`，或用 `start_sol_coordination` 取得 ID 后以 `wait_sol_coordination` 等待。续等使用同一 `idempotencyKey` 和返回的 `taskId`；引用过期时重新签发后续等。`get_sol_coordination` 读原回执，`cancel_sol_coordination` 向本连接拥有的任务请求取消。断连、未知终态和未确认取消时，先检查原任务，保留原幂等键。`get_sol_schedule` 和 `set_sol_schedule` 单独查看和调整本根池的 `scheduleMode`。

## 回滚

安装输出本机回滚 manifest。活动任务安全结束后可回滚该次注册和文件变更。

```powershell
.\scripts\install.ps1 -RollbackManifest 'C:\...\ai-rule-backups\...\manifest.json'
```

若安装后的配置已有改动，回滚会停在哈希校验。按实际内容合并，保留已改配置和各后端运行记录。运行数据、API 密钥和 Codex 分享范围均由每台机器自行管理。
