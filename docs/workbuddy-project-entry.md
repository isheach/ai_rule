# WorkBuddy DSF 项目入口

在已装 WorkBuddy 的机器上，一次把已批准的项目根配置给 `deepseek-v4-flash-workbuddy`。此后 Sol 按当前任务给出目标、绝对 `cwd`、论文、脚本或数据，以及可共享的相关记忆和验收标准。例如，在同一个获准研究目录内从 SYRAN 切到 Shirdel，只更新任务书和新任务键，即可沿用原项目授权及已加载的服务，无需另建 profile 或刷新服务。

显式选择 WorkBuddy DSF 时由 Sol 直接走该入口。DSH 峰谷模式 2 在谷时走 DSH，真实峰时的新任务使用同一个 WorkBuddy 入口，提前门禁、预算、原任务和单次领取规则按原日历执行。协调来源仍由当前会话单独选择。 [峰谷调度](offpeak-schedule.md) · [Sol 协调来源](sol-coordinator.md)

## 一次迁移

使用现有 WorkBuddy 和 Codex 的 Windows 用户、Node 22 或更新版本，以及本机实际的仓库副本。同步代码后，在仓库根安装项目入口所需的固定 SDK 版本。

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Git 同步失败' }
npm.cmd ci --ignore-scripts --prefix bridges/workbuddy
if ($LASTEXITCODE -ne 0) { throw 'WorkBuddy SDK 安装失败' }
```

从本机现有 WorkBuddy 安装和已核实的旧桥启动设置确认实际执行的脚本与原账户配置目录。本机配置引用该目录，认证结果以本机验收为准。厂商的 WorkBuddy 和独立 CodeBuddy CLI 可以使用不同配置目录，以原桥实际设置为准。 [CodeBuddy 配置目录说明](https://www.codebuddy.cn/docs/cli/release-notes/v2.48.0)

固定本机 WorkBuddy 安装中 `resources\app.asar.unpacked\cli\dist` 下实际使用的 `codebuddy-lite-wb.mjs` 或 `codebuddy-headless.js` 的绝对路径及 SHA-256。旧桥通过 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 启动 lite bundle 时，选择已核实的 `codebuddy-lite-wb.mjs`。直接指定该文件，避免 SDK 重写 `bin\codebuddy` 启动器路径。桥接器使用所选脚本和锁定的 `@tencent-ai/agent-sdk@0.3.305`，兼容、模型或安全检查失败即报告阻塞。已记录的 WorkBuddy 捆绑 CLI 2.165.0 对该 SDK 的兼容性待本机验收。 [Tencent Agent SDK](https://www.codebuddy.cn/docs/cli/sdk)

填写前三个路径后运行下面的 PowerShell。示例采用只读。如果既有实验授权已覆盖项目内文件写入及 MATLAB 等原生命令，在初始项目配置中把 `allow_write` 和 `allow_commands` 都设为 `$true`，沿用已获批准的范围，无需重新确认。已有合适的本机 JSON 时直接沿用其路径。 [配置模板](../config/workbuddy-project.example.json)

```powershell
$wbCli = (Resolve-Path -LiteralPath 'D:\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs' -ErrorAction Stop).ProviderPath
$wbAccount = (Resolve-Path -LiteralPath '<现有 WorkBuddy 账户配置目录>' -ErrorAction Stop).ProviderPath
$projectRoot = (Resolve-Path -LiteralPath '<已批准的物理项目根目录>' -ErrorAction Stop).ProviderPath
$wbHash = (Get-FileHash -LiteralPath $wbCli -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()

$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$wbState = Join-Path $codexDir 'ai-rule-workbuddy'
$wbConfig = Join-Path $wbState 'workbuddy-project.local.json'
if (Test-Path -LiteralPath $wbConfig) { throw '项目配置已存在，请沿用或就地核实该文件。' }
New-Item -ItemType Directory -Path $wbState -Force -ErrorAction Stop | Out-Null
[ordered]@{
    schema = 1
    workbuddy_cli = $wbCli
    cli_sha256 = $wbHash
    workbuddy_config_dir = $wbAccount
    runtime_dir = (Join-Path $wbState 'runtime')
    projects = @(@{
        id = 'research'
        root = $projectRoot
        allow_write = $false
        allow_commands = $false
    })
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $wbConfig -Encoding utf8 -ErrorAction Stop
```

项目、CLI 和账户配置应使用已存在的绝对物理路径。项目根互不重叠，与 WorkBuddy 安装、账户配置、本机 JSON 及运行目录物理分离。将项目 ID 稳定地绑定到获准根目录。若旧授权只覆盖较小目录，按原范围配置。原生命令需同时有写入和命令授权。凭据和本机配置留在本机。

安装器用同名注册迁移现有 DSF。先预览，待旧 WorkBuddy 任务取得终态后应用并验证。首次添加缺少的同名服务时省略 `-ReplaceWorkBuddyDsf`。预览和验证检查本机配置及注册，不提交模型任务。

```powershell
$wbInstallArgs = @{ WorkBuddyProjectConfig = $wbConfig; ReplaceWorkBuddyDsf = $true }
.\scripts\install.ps1 @wbInstallArgs
.\scripts\install.ps1 -Apply @wbInstallArgs
.\scripts\install.ps1 -Verify
```

PowerShell 脚本受本机执行策略限制时使用等价的 Node 命令。将配置变量设为上述本机绝对路径。

```powershell
$wbNodeArgs = @('--workbuddy-project-config', $wbConfig, '--replace-workbuddy-dsf')
node .\scripts\manage.mjs @wbNodeArgs
if ($LASTEXITCODE -ne 0) { throw '安装预览失败' }
node .\scripts\manage.mjs --apply @wbNodeArgs
if ($LASTEXITCODE -ne 0) { throw '安装失败' }
node .\scripts\manage.mjs --verify
```

应用会备份原注册并输出回滚 manifest。`-Verify` 的 `workbuddy_dsf_project.structure_valid` 检查结构。保留已在运行的任务和进程。就绪后按当前宿主支持的方式加载变更的 DSF 服务一次，并由真实 Sol 确认项目工具已可见。宿主只在新会话读取注册时，在能加载该注册的会话做验收。活动任务仍从原入口收尾。Git 同步更新代码和规则，本机安装、会话记录和运行状态各自维护。

API Sol 已在使用时，让 `coordinator.local.json` 中的 `workbuddy.project_config` 指向同一个本机 JSON，然后按 API 协调器的现有安装流程应用并加载该配置一次。订阅 Sol 可直接使用上面已加载的 DSF 服务。 [API Sol 的 WorkBuddy 设置](sol-coordinator.md#使用-workbuddy-dsf)

## Sol 派单

| 工具 | 调用和验证 |
|---|---|
| `get_task_bridge_status` | 传当前绝对 `cwd`、`permissionMode` 和适用的任务限制。用 `ready: true`、`project_contract: "project-v1"`、`model: "deepseek-v4-flash"` 和 `project_id` 验证当前入口。 |
| `run_workbuddy_task` | 将 `project_id` 作为 `projectId`，传 `prompt`、`cwd`、`idempotencyKey` 与 `permissionMode`。按需传 `timeoutMs`、`capability`、`authorizationNote` 及更窄的授权 scope。同步返回真实任务回执。 |
| `get_workbuddy_task` | 传原 `idempotencyKey`，查询原任务 ID、结果及已取得的会话。断连后先读原回执，未知或仍在运行时保留原任务。 |

`read-only` 用于只读任务。`workspace-write` 受项目的 `allow_write` 限制。选能涵盖本轮文件的已获批 `cwd` 作为任务边界。使用 `writes`、`writeScopes` 或 `commands` 收窄时，明确传 `capability: "workspace-write"`。`writes` 指定文件以及 `create`、`edit` 或 `write`，`writeScopes` 指定现有目录及允许的 `create`、`replace`、`edit` 操作，`commands` 指定完整命令。`authorizationNote` 可引用既有的项目授权。真实超出范围时才补充授权。原生命令使用操作系统账户权限，受桥的工具校验及厂商正常权限设置约束。是否有额外 OS 隔离取决于宿主。

每项新任务用一个新的非秘密键。网络重试或恢复状态沿用原键。明确继续原 WorkBuddy 会话时，使用原任务回执中的 `session_id` 作为 `sessionId`，沿用同工作目录、项目和权限 scope，并为续跑使用新键。模式 2 还使用同目录的已完成交接记录。受理不明时保留原运行记录及锁，由原协调者核实终态。

## 本机验收与回滚

1. 由真实 Sol 在已批准的 `cwd` 调用状态工具。核对新契约、项目 ID、所需权限和固定模型。ready 是目录和设模检查，真实模型任务及用量由本机回执和账单核对。
2. 用同一项目授权及已加载服务连续派两项低风险任务，各读一个已批准的非敏感文件或子目录，例如先读 SYRAN 输入再读 Shirdel 输入。每项用自己的键，比较真实 `task_id`、固定模型、终态和结果证据，并用原键查回执。配置、授权和服务在两项之间直接沿用。有写入或命令授权时，再用项目内的可逆操作核对实际工具效果。
3. 用模式 2 时，在实际峰段从正常 DSH 派单核实一次领取和终态回填，谷时核实 DSH 路由。谷时可对步骤 2 使用“仅本次 WorkBuddy DSF”做独立 smoke，保留会话选择。 [模式 2 的验收路径](offpeak-schedule.md#模式-2-的峰时派发)

模型、认证、哈希或项目能力核验失败时记录真实阻塞。CLI 更新导致哈希变化时，核实新的本机安装后再更新 pin，待活动任务结束时按宿主支持方式载入这一入口。登记的目录和任务输入可继续沿用。

如需恢复旧注册，等相关任务完成后，用这次安装输出的 manifest 执行 `.\scripts\install.ps1 -RollbackManifest '<该次备份的 manifest.json>'`，然后按宿主支持方式载入恢复的 DSF 注册。配置若在安装后被其他操作改动，按安装器的哈希冲突提示保留现有改动并本机合并。备份和任务记录留在本机。
