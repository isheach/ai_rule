# Sol 协调器

部署本机 `sol-coordinator` 后，可在 Codex 会话内选择原生订阅 Sol 或独立 OpenAI Responses API Sol。API 任务使用所配 DSH 根池或 WorkBuddy DSF。会话选择、派发、等待与恢复以 [调度 Skill](../skills/multi-agent-dispatch/SKILL.md) 为准。

## Windows 安装

以下步骤注册协调器。在现有 Codex 和 DSH 所在的普通 Windows 会话中操作，使用 Node 22 或更新版本。把例子里的工作区替换成获准的现有目录。模型与档位使用该 API 项目实际能验证的值。

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

## 独立凭据代理

Windows 部署分为协调器注册和独立的 `AiRuleSolBroker` 服务。服务使用 `NT SERVICE\\AiRuleSolBroker` 身份，以该身份的 DPAPI CurrentUser 保存密钥。Codex、订阅 Sol、API Sol 协调器和两个 DeepSeek 执行入口都没有读取密钥的接口。模型 ID 和档位须与现有协调器配置一致。

### 迁移现有机器

1. 在各活动会话中保留原任务 ID、幂等键和入口。需要在迁移期间开工的会话可以明确选择订阅 Sol。等旧 API 协调任务结束再重载对应 MCP。
2. 若此前使用过真实的环境变量密钥，另建一把专用于代理的项目密钥，在本机安全窗口中设置。撤销旧密钥，移除旧用户或机器环境变量及 MCP 注册中的转发项，再重新启动继承过旧环境的应用。实际使用过自定义变量名时也清理这些变量。避免显示变量值或导出环境快照。历史副本的风险靠撤销旧密钥消除。
3. 对原协调配置执行上方的预览、应用与结构验证。仅含旧 `api_key_env` 的配置会在原文件就地替换为 `"credential_source": "windows-broker"`。含 `project_env` 或 `organization_env` 的配置会提示人工迁移：先在管理员安装策略中固定原项目或组织标识，再仅替换这些旧引用和 `api_key_env`。保留原 `model`、`reasoning_effort`、`response_model`、`pool_config`、`state_dir` 和 `workbuddy`。自管 MCP 注册要自行移除旧 OpenAI 转发项。
4. 从管理员控制、版本经过核对的仓库副本运行服务安装。该副本应在执行器可写目录之外。Codex、DSH 和 WorkBuddy 日常以非提升权限运行。管理员身份和 SYSTEM 属于本机信任边界。

### 安装服务和设置密钥

先在实际运行 Codex 的普通用户 PowerShell 中取得调用者 SID。它是 Windows 账户标识，可以提供给本机安装程序。

```powershell
[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
```

另开本机 64 位管理员 PowerShell（Windows PowerShell 5.1 或更新版本，并已安装 .NET Framework 4.8），进入上述受保护源码目录。将占位 SID 替换为上一步结果，保留实际 API 模型及档位。原来指定 OpenAI 项目或组织时，在安装命令上分别传 `-ProjectId`、`-OrganizationId`。

```powershell
.\bridges\sol\broker\windows\install.ps1 -ClientSid 'S-1-5-21-填入实际账户SID' -Model 'gpt-6.2-sol' -ReasoningEffort 'max'
$brokerExe = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'AiRuleSolBroker\SolBroker.exe'
& $brokerExe check
& $brokerExe set-key
```

只在 `set-key` 打开的本机交互提示内输入密钥。密钥不会出现在命令、历史记录、MCP 配置和项目文件里。日后轮换也走这个命令。管理员检查与录入均不连接 OpenAI。普通调用者只获准查询状态并提交有限的 Responses 请求；同一获准 Windows 身份下的程序可以消耗该身份共享的 API 配额。

代理最多受理每小时 24 次上游请求，单次请求体上限 768,000 字节、输出上限 64,000 tokens，上游超时 180 秒。协调配置中更低的限制继续生效。限额按服务共享，跨服务重启保留；并发上限为三次上游请求，状态查询走独立管道。管理员可在受保护的 `%ProgramFiles%\AiRuleSolBroker\state\audit.jsonl` 查看时间、操作、结果与状态码。日志定长轮换，排除请求与响应正文、密钥、请求头及组织和项目标识。

### 验证和切换

在运行 Codex 的普通用户窗口执行：

```powershell
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$solConfig = Join-Path $codexDir 'ai-rule-sol\coordinator.local.json'
node .\bridges\sol\cli.mjs broker-status --config $solConfig
```

使用显式配置时将 `$solConfig` 替换为原路径。`ready: true` 表示本地身份、密钥状态和模型策略检查通过。它无法验证远端项目权限、模型可用性或余额。在 Codex 里选择“本会话 Sol 主控切到 API”或“本会话 Sol 主控切回订阅”，切换本身没有模型用量。正在进行的任务继续由原协调来源和执行后端负责。代理不可用时，API 任务明确报告阻塞。无法部署独立身份时，先选订阅 Sol；需要 API 的机器也可改用单独的受控 Windows 主机，将 DeepSeek 执行器隔离在外。

**真实验证会向 OpenAI 提交一个模型请求，产生计费用量。** 只有决定付费验证时才执行下面这一条命令，检查 `verified`、`returned_model`、推理档位和 `usage`。离线测试、安装、状态查询及切换不执行该命令。

```powershell
node .\bridges\sol\cli.mjs verify-api --config $solConfig --accept-api-charges
```

代理向官方 Responses 提交获准的任务和相关执行结果，使用 `store: false`。协调器保留模型、档位、响应与执行任务 ID 和可确认的用量。断连后按原任务键查回执。 [凭据路径审计](implementation.md#api-sol-凭据路径)

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

暂时停用 API 时，先在需要的会话明确切回订阅 Sol；已受理任务仍用原 ID 等待或查询。若要彻底撤销部署：

1. 等已有 API 协调任务结束。在管理员控制的源码目录执行 `.\bridges\sol\broker\windows\install.ps1 -Uninstall`。此操作会删除服务、代理程序、已保存的加密密钥、限额记录及代理审计文件；需留存的审计先由管理员保全。
2. 若这把 OpenAI 项目密钥也要停用，在 OpenAI 项目中撤销。卸载本机副本不会撤销远端密钥。
3. 如需恢复安装前的协调器注册，使用原安装输出的 manifest 执行 `.\scripts\install.ps1 -RollbackManifest '<实际 manifest 路径>'`，按提示处理其后的本地修改，再重载宿主。回滚后的旧版继续用订阅 Sol，避免重新给旧环境变量赋值。回滚服务不需要操作 DSH、WorkBuddy 或已有任务目录。 [回滚步骤](../README.md#更新规则与回滚)
