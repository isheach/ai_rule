# Sol 协调器

部署本机 `sol-coordinator` 后，可在 Codex 会话内选择原生订阅 Sol 或独立 OpenAI Responses API Sol。API 任务使用所配 DSH 根池或 WorkBuddy DSF。会话选择、派发、等待与恢复以 [调度 Skill](../skills/multi-agent-dispatch/SKILL.md) 为准。

## Windows 安装

在现有 Codex 和 DSH 所在的 Windows 用户下操作，使用 Node 22 或更新版本。把例子里的工作区替换成获准的现有目录。模型与档位使用该 API 项目实际能验证的值。

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Git 同步失败' }

$solInstall = @{
    SolWorkspaceRoot = 'D:\Projects\approved'
    SolModel = 'gpt-6.2-sol'
    SolReasoningEffort = 'max'
}
.\scripts\install.ps1 @solInstall
.\scripts\install.ps1 -Apply @solInstall
.\scripts\install.ps1 -Verify
```

PowerShell 脚本受本机执行策略限制时，可使用 Node。

```powershell
$solArgs = @('--sol-workspace-root', 'D:\Projects\approved', '--sol-model', 'gpt-6.2-sol', '--sol-reasoning-effort', 'max')
node .\scripts\manage.mjs @solArgs
if ($LASTEXITCODE -ne 0) { throw '安装预览失败' }
node .\scripts\manage.mjs --apply @solArgs
if ($LASTEXITCODE -ne 0) { throw '安装失败' }
node .\scripts\manage.mjs --verify
```

预览、应用和结构验证使用本机数据。标准根池的工作区和只读设置与所需范围相符时，生成配置可引用同一个池。只有传统 DSH 时，安装器沿用可继承的 DSH JavaScript 入口、日历和只读限制，生成独立根池配置。找不到本机 JS 入口时可传 `-DshEntry`。已有传统或命名实例的活动任务由原协调者继续处理。

自定义入口不能安全继承时，使用 [Sol 配置模板](../config/sol-coordinator.example.json) 编写本机 JSON。`pool_config` 指向匹配当前工作区和权限的 [根池配置](root-pool.md)。`state_dir` 与获准工作区、根池、上下文以及旧 DSH runtime 分开，再用完整本机配置预览、应用和验证。

```powershell
$solConfig = 'D:\ai-rule-state\sol-coordinator.local.json'
.\scripts\install.ps1 -SolCoordinatorConfig $solConfig
.\scripts\install.ps1 -Apply -SolCoordinatorConfig $solConfig
.\scripts\install.ps1 -Verify
```

`sol_coordinator.structure_valid: true` 表示托管注册和配置能够通过结构校验。待受影响的已有任务结束后，按宿主支持的方式加载。在可读到新注册的会话中核对 `codex mcp list` 和实际工具。完成一次本机设置后，协调来源可在会话里切换。

## API 凭据和验证

API 密钥由启动 Codex 的进程环境提供。默认变量是 `SOL_OPENAI_API_KEY`，注册仅记录变量名。可在当前 Windows 用户的环境变量中配置，或临时设置于随后启动 Codex 的 PowerShell。从已配置的新环境启动 Codex 和所需父进程。首次验证需要实际请求 API，会产生用量。 [OpenAI 模型目录](https://developers.openai.com/api/docs/models) · [Codex MCP 环境配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```powershell
$key = Read-Host 'OpenAI API key' -AsSecureString
$env:SOL_OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $key).Password
Remove-Variable key

$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$solConfig = Join-Path $codexDir 'ai-rule-sol\coordinator.local.json'
node .\bridges\sol\cli.mjs verify-api --config $solConfig
```

显式配置应替换上方的 `$solConfig`。检查 `verified`、`returned_model`、`reasoning_effort` 和 `usage`。若模型别名与经核实的返回快照不同，可在本机配置 `response_model`。需要项目或组织请求头时，在 `openai` 中配置 `project_env` 或 `organization_env`，并以同一完整配置应用注册以转发变量名称。

协调器向官方 Responses 发送获准的本轮任务和相关执行结果，设置 `store: false`。进程读取指定 OpenAI 凭据并清除下游继承。实际交接只包含可共享的任务背景与证据。回执记录 Responses 和执行任务 ID、返回模型、档位、终态及已知用量。模型不符、认证、限流或受理不明按实际状态报告，渠道选择仍保留。 [实现边界](implementation.md#权限进程与数据)

独立 API 请求使用所配置 API 项目的额度。ChatGPT 赠送 API 额度的资格和扣减规则以 OpenAI 说明及实际 API 账单为准。协调配置的 `max_total_tokens` 根据已返回的用量决定是否继续下一轮，最后一轮可能使合计超过阈值。可配的请求数、输出和时间限制约束此协调任务。 [API 赠额](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions) · [API 账单](https://platform.openai.com/account/billing/overview)

## WorkBuddy DSF

### 项目入口

先准备好已有授权的本机项目配置。将以下 `workbuddy` 对象写入完整的协调配置，按上方 `-SolCoordinatorConfig` 流程应用并载入。显式 WorkBuddy DSF 和模式 2 的实际峰时派发均可由这一连接执行。API 借用同一本机项目 JSON 和工具实现，本次目录与权限还受协调器工作区和只读上限约束。 [项目配置](workbuddy-project-entry.md#项目配置)

```json
{
  "workbuddy": {
    "project_config": "D:\\ai-rule-state\\workbuddy-project.local.json"
  }
}
```

本机项目入口已加载后，同一批准范围内换课题、论文、数据或实验脚本时，仅按任务交接输入及适用范围。协调器沿用已有项目及授权，任务范围可收窄。 [WorkBuddy 工具参数](../skills/multi-agent-dispatch/references/workbuddy.md#项目入口)

### 已有定制入口

按本机已核实的定制桥 stdio 入口和已批准 profile 设置。可将现有 `codex mcp get deepseek-v4-flash-workbuddy --json` 结果保存到变量，仅提取批准的 `transport.command`、`args`、`cwd` 和所需环境变量名称。将示例中的工具字段和 profile 替换成实际值。

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

定制连接使用固定 `WB_MODEL=deepseek-v4-flash` 与 `WB_SKIP_PERMISSIONS=false`。状态默认字段是 `ready`、`model`，结果默认字段是 `status`、`model`、`task_id`、`session_id`、`answer`，可用 `status_fields` 和 `result_fields` 匹配原桥。可通过 `env_vars` 传递所需非 OpenAI 环境变量名称，通过 `arguments.session` 映射已验证的续跑参数。配置已有获准工作区可写能力时，使用对应的 `workspace-write` profile。该定制适配器使用默认能力及 profile，显式结构化文件或命令范围由项目入口处理。

用完整本机配置重新预览、应用、验证，等活动协调安全结束后载入。用一项获准任务查实际 tools/list、readiness、请求、回执和续跑能力。缺少可用 WorkBuddy 连接时，模式 2 的峰时任务报告阻塞。 [既有定制桥](../bridges/workbuddy/README.md)

## 使用、恢复与回滚

在 Codex 中说“本会话 Sol 主控切到 API”即可设置会话来源。需要单项覆盖时说“仅本次由 API Sol 主控”。选择、派发的工具参数和已有任务的恢复见 [调度 Skill](../skills/multi-agent-dispatch/SKILL.md#openai-responses-api-sol)。发生断连、超时或受理不明时，用原任务键、ID 和当前有效根上下文查原协调记录及下游状态。

需要回滚时，等待相关活动任务取得终态，用应用命令输出的该次本机备份 manifest 按标准流程恢复。 [回滚步骤](../README.md#更新规则与回滚)
