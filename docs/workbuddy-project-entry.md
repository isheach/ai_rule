# WorkBuddy DSF 项目入口

使用本机现有 WorkBuddy 及同名 MCP `deepseek-v4-flash-workbuddy`。为已批准的物理项目建立一次记录。显式 WorkBuddy DSF 与 DSH 模式 2 的实际峰时派发都可使用这项配置。订阅或 API Sol 的来源按会话单独选择。 [WorkBuddy 运行参考](../skills/multi-agent-dispatch/references/workbuddy.md) · [峰时交接](offpeak-schedule.md#模式-2-的峰时派发)

## 准备已有安装

要求 Node 22 或更高版本。进入本机仓库目录、同步代码并安装锁定的 SDK。

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Git 同步失败' }
npm.cmd ci --ignore-scripts --prefix bridges/workbuddy
if ($LASTEXITCODE -ne 0) { throw 'WorkBuddy SDK 安装失败' }
```

从已安装 WorkBuddy 和现有桥接启动设置核实实际 CLI 脚本、原账户配置目录。项目入口使用 `resources\app.asar.unpacked\cli\dist` 下实际生效的 `codebuddy-lite-wb.mjs` 或 `codebuddy-headless.js`。旧桥 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 对应已核实的 lite bundle。直接配置该文件及 SHA-256，供锁定的 `@tencent-ai/agent-sdk@0.3.305` 使用。WorkBuddy 与独立 CodeBuddy 的账户目录可能有差异，使用旧桥实际配置。 [CodeBuddy 配置目录](https://www.codebuddy.cn/docs/cli/release-notes/v2.48.0) · [Tencent Agent SDK](https://www.codebuddy.cn/docs/cli/sdk)

## 项目配置

模板和下面的脚本以只读项目为例。已获准项目写入时将 `allow_write` 设为 `$true`，已获准项目内原生命令时将 `allow_commands` 同时设为 `$true`。例如以前已批准的实验写入和 MATLAB 可以沿用。项目根按真实批准范围填写。已有适用 JSON 可直接复用其路径。 [项目模板](../config/workbuddy-project.example.json)

```powershell
$wbCli = (Resolve-Path -LiteralPath 'D:\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs' -ErrorAction Stop).ProviderPath
$wbAccount = (Resolve-Path -LiteralPath '<现有 WorkBuddy 账户配置目录>' -ErrorAction Stop).ProviderPath
$projectRoot = (Resolve-Path -LiteralPath '<已批准的物理项目根目录>' -ErrorAction Stop).ProviderPath
$wbHash = (Get-FileHash -LiteralPath $wbCli -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()

$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$wbState = Join-Path $codexDir 'ai-rule-workbuddy'
$wbConfig = Join-Path $wbState 'workbuddy-project.local.json'
if (Test-Path -LiteralPath $wbConfig) { throw '项目配置已存在，请核实并沿用该文件。' }
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

固定项目 ID 及已存在的绝对物理根。项目根互不重叠，与 WorkBuddy 安装、账户配置、本机 JSON 和 runtime 分离。更窄的用户任务边界随当前工作传入。通过校验的原生命令以当前 OS 账户权限运行，宿主审批照常生效。CLI 升级后核实实际脚本并更新 pin，在活动工作安全结束时按宿主支持方式加载一次。

## 同名安装或迁移

将 `$wbConfig` 指向本机 JSON。已经注册旧 DSF 时显式传替换选项，首次添加时省略。先预览，待旧 WorkBuddy 任务结束后应用并验证。

```powershell
$wbInstallArgs = @{ WorkBuddyProjectConfig = $wbConfig; ReplaceWorkBuddyDsf = $true }
.\scripts\install.ps1 @wbInstallArgs
.\scripts\install.ps1 -Apply @wbInstallArgs
.\scripts\install.ps1 -Verify
```

PowerShell 执行策略限制脚本时使用 Node。

```powershell
$wbNodeArgs = @('--workbuddy-project-config', $wbConfig, '--replace-workbuddy-dsf')
node .\scripts\manage.mjs @wbNodeArgs
if ($LASTEXITCODE -ne 0) { throw '安装预览失败' }
node .\scripts\manage.mjs --apply @wbNodeArgs
if ($LASTEXITCODE -ne 0) { throw '安装失败' }
node .\scripts\manage.mjs --verify
```

`workbuddy_dsf_project.structure_valid` 表示安装结构可核对。按宿主支持的方式加载新 DSF 入口，随后由真实 Sol 检查实际工具和权限。API Sol 可通过 `workbuddy.project_config` 引用同一 JSON，首次设置时加载协调配置。 [API WorkBuddy 设置](sol-coordinator.md#workbuddy-dsf)

## 使用与验收

由真实 Sol 以本次 cwd 和权限调用 `get_task_bridge_status`。检查 `project-v1`、`project_id`、ready 和 `deepseek-v4-flash`。随后在同一个已批准的项目里执行两项实际任务，例如从 SYRAN 的输入切到 Shirdel 的脚本和数据。换当前任务书与幂等键，沿用授权及已加载服务。核对实际的键、模型、终态和工具结果。已批准写入或原生命令时，可用项目中现有的可逆检查核对效果。

已观察的 WorkBuddy 捆绑 CLI 2.165.0 仍需在实际机器验证与 SDK 的兼容性。认证、哈希或模型错误以实际回执为准。需要恢复旧注册时，待相关任务终态后按安装输出的 manifest 回滚，再加载原入口。 [通用回滚步骤](../README.md#更新规则与回滚)
