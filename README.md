# ai_rule

在 Codex 中保留三项按会话选择的设置，由实际 Sol 协调者完成派发和验收。规则见 [AGENTS.md](AGENTS.md)，安装后随附 [multi-agent-dispatch Skill](skills/multi-agent-dispatch/SKILL.md)。

| 会话设置 | 全新会话默认 | 可选项 |
|---|---|---|
| Sol 协调来源 | Codex 订阅 | 订阅、独立 OpenAI Responses API |
| 执行模式 | A 原生 | A、DSH、WorkBuddy DSF、HY4 |
| DSH 峰谷 | 1 无峰谷 | 1 无峰谷、2 实际峰时用 WorkBuddy DSF、3 原峰谷 |

Astra 负责总体方向。A 由原生 Sol 执行，外部模式由所选 Harness 执行。订阅 Sol 在自己的宿主上下文调用执行 MCP，API Sol 在 `sol-coordinator` 的 Responses 工具循环中调用已配置的执行入口。用户明确指定后，同一会话的后续任务沿用该选择。新任务和恢复旧任务的示例见 [会话操作](docs/session-modes.md)。

## Windows 安装

在运行 Codex 和 DSH 的普通 Windows 账户中操作，准备 Git、Node 22 或更新版本及能正常运行的 DSH headless 配置。DSH 所用路由为 `opencode-go / deepseek-v4.1-flash / max`。将示例的 `$sourceRoot` 设为要安装的本机源码副本的绝对路径。按未合并的 PR 或指定提交安装时，先获取并核对该提交。 [固定源码修订](docs/sol-coordinator.md#固定源码修订)

```powershell
$sourceRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'ai_rule'
$manage = Join-Path $sourceRoot 'scripts\manage.mjs'
& {
    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path -LiteralPath $sourceRoot)) {
        git clone --quiet https://github.com/isheach/ai_rule.git $sourceRoot
        if ($LASTEXITCODE -ne 0) { throw 'Git 克隆失败' }
    }
    node $manage --enable-dsh
    if ($LASTEXITCODE -ne 0) { throw '安装预览失败' }
    node $manage --apply --enable-dsh
    if ($LASTEXITCODE -ne 0) { throw '安装失败' }
    node $manage --verify
}
```

三个 Node 调用依次预览、应用以及检查文件与托管注册。DSH 预检查核对现有 CLI、headless 路由和工具参数。若需要手动定位入口，用 `--dsh-entry` 指向实际 `@deepseek-ai\dsh\lib\bin.js`。修订本机 headless 配置时，按原 profile 的结构合并相关字段。 [headless 配置示例](config/headless.patch.example.yml)

新 DSH 服务默认 `workspace-write`，按本次授权和宿主边界工作。可用 `-ReadOnly` 或 `--read-only` 设置服务只读，或以 `permissionMode: "read-only"` 限制单项任务。安装器保留已注册服务的显式只读设置。已有 WorkBuddy 或 HY4 的机器按下方对应文档管理这些入口。

在目标 Windows 机核对安装结构，再按实际 Codex 宿主支持的方式加载，由真实 Sol 确认工具可用。已有任务先由原入口收尾。下一项已批准的任务可以核验真实调用者、任务回执和结果。若当前只具备云端源码入口，先完成代码和离线检查，目标机接入以本机证据另行核验。 [安装验收](docs/implementation.md)

## 可选入口

| 需要 | 设置说明 |
|---|---|
| 同一根会话并行多个独立 DSH 任务 | [DSH 根池](docs/root-pool.md) |
| 宿主按 MCP 服务分配多个独立 DSH 实例 | [DSH 命名实例](docs/multisession.md) |
| 切换订阅/API Sol，按固定提交运行 `scripts/setup-sol.ps1` 并检查本机就绪 | [Sol 协调器与安装步骤](docs/sol-coordinator.md) |
| 复用既有 WorkBuddy 安装、账户及项目授权 | [WorkBuddy DSF 项目入口](docs/workbuddy-project-entry.md) |
| 启用官方 CodeBuddy ACP 的 HY4 | [CodeBuddy ACP](docs/codebuddy-acp.md) |
| DSH 谷时治理及模式 2 实际峰时的 WorkBuddy 交接 | [峰谷调度](docs/offpeak-schedule.md) |
| 模式 3 中明确授权的 DSH → HY4 预准入回退 | [HY4 回退](docs/hy4-fallback.md) |

只部署 DSH 的电脑可以使用 A、DSH 及所配日历的 DSH 时段。WorkBuddy 的注册检查在这类电脑上可以是 `false`。项目入口的模板使用只读示例。已经批准读写或命令的研究项目按实际授权设置一次，同一项目的后续论文、数据、脚本与任务直接随派单更换。 [项目权限设置](docs/workbuddy-project-entry.md#项目配置)

## 更新规则与回滚

只更新规则及 Skill 时，先准备各目标机要安装的源码。更新已发布分支可在其实际副本运行 `git -C $sourceRoot pull --ff-only` 并检查 `HEAD`。安装尚未合并的 PR 或指定提交时，按固定源码流程检出。将 `$sourceRoot` 指向已核对的本机源码绝对路径，然后在目标普通用户账户运行以下命令。 [固定源码修订](docs/sol-coordinator.md#固定源码修订)

```powershell
$manage = Join-Path $sourceRoot 'scripts\manage.mjs'
& {
    $ErrorActionPreference = 'Stop'
    node $manage
    if ($LASTEXITCODE -ne 0) { throw '安装预览失败' }
    node $manage --apply
    if ($LASTEXITCODE -ne 0) { throw '规则安装失败' }
    node $manage --verify
}
```

无入口选项时，预览只列当前有效的全局 AGENTS 和 `~/.agents/skills/multi-agent-dispatch` 中的 Skill 及其引用。非空 `AGENTS.override.md` 是合并目标。验证时应看到 `rules_current: true`，表示这些文件与当前源码相符。若需更新某个 MCP 注册，按对应入口文档预览并应用。Git 同步的内容在各机器上分别安装，本机配置、凭据、会话及运行目录各自保留。

会话内继续已有工作时，让 Astra 与原 Sol 显式重读已安装规则。现有任务先保留原进程和权限。更新桥接源码或注册后，在任务取得终态时通过宿主支持的方式加载相关服务一次，再确认工具可见。同一已批准项目里的任务输入变更直接随派单传入。

应用命令输出本机备份 `manifest.json`，可用 `node $manage --rollback $manifest` 回滚，传入该 manifest 的绝对路径。安装后又修改过的目标需按哈希冲突提示核对并合并。备份留在本机。离线回归用 `npm.cmd --prefix $sourceRoot test`。 [实现边界与验收](docs/implementation.md)
