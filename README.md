# ai_rule

在 Codex 中保留三项按会话选择的设置，由实际 Sol 协调者完成派发和验收。全新独立会话默认由订阅的 GPT-6.2 Sol Max 协调，底层用 DSH/OpenCode Go DSF；主机操作/验收、写作、绘图/图像生成与识别由同一来源的 GPT-6.1 Terra Max 承担。规则见 [AGENTS.md](AGENTS.md)，安装后随附 [multi-agent dispatch Skill](skills/multi-agent-dispatch/SKILL.md)。

| 会话设置 | 全新会话默认 | 可选项 |
|---|---|---|
| Sol 协调来源 | Codex 订阅 | 订阅、受保护 OpenAI Responses API |
| 中间层模型 | GPT-6.2 Sol Max | 专家任务使用 GPT-6.1 Terra Max |
| 底层执行 | DSH/OpenCode Go DSF | A 原生、DSH、WorkBuddy DSF、HY4 |
| DSH 峰谷 | 1 无峰谷 | 1 无峰谷、2 实际峰时用 WorkBuddy DSF、3 原峰谷 |

全新默认只用于独立新会话，不改写已有的 A/外部模式、模式 3、来源、已受理任务或所有者。A 由原生 Sol 执行，专家任务需用户明确选择；外部模式由所选 Harness 执行；WorkBuddy DSF 是底层显式替代，不是默认或自动回退。订阅 Sol 在自己的宿主上下文调用执行 MCP，API Sol 在 `sol-coordinator` 的 Responses 工具循环中调用已配置的执行入口。用户明确指定后，同一会话的后续任务沿用该选择。新任务和恢复旧任务的示例见 [会话操作](docs/session-modes.md)。

Terra 专家任务使用与 Sol 相同的已选中间来源。纯写作可直接返回文本；主机操作/验收、绘图或图像生成与识别只通过实际提供的 CUA/图像工具或项目预注册动作，限定范围的 CUA 完成后关闭，不虚构工具动作。API 仅在用户明确选择后使用，付费调用只在授权后执行。

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

Sol API 与 Terra API 共用同一 Windows 项目、broker 和每小时配额。新装为 100 次/小时；缺少 `requests_per_hour` 的旧策略仍为 24，已有 96 等显式值保留，高于 100 的值不降低。只有用户授权并显式预览、应用受保护升级才把低于 100 的值提高到 100，不会静默迁移；运行中的服务需在在途调用结束后显式使用 `-AllowBriefRestart`。订阅及 OpenCode Go/WorkBuddy 的额度按各自渠道计。 [共享配额与升级](docs/sol-coordinator.md#api-配额)

在目标 Windows 机核对安装结构，再按实际 Codex 宿主支持的方式加载，由真实 Sol 确认工具可用。已有任务先由原入口收尾。下一项已批准的任务可以核验真实调用者、任务回执和结果。若当前只具备云端源码入口，先完成代码和离线检查，目标机接入以本机证据另行核验。 [安装验收](docs/implementation.md)

## 可选入口

| 需要 | 设置说明 |
|---|---|
| 同一根会话并行多个独立 DSH 任务 | [DSH 根池](docs/root-pool.md) |
| 宿主按 MCP 服务分配多个独立 DSH 实例 | [DSH 命名实例](docs/multisession.md) |
| 切换订阅/API Sol 或 Terra，按固定提交运行 `scripts/setup-sol.ps1` 并检查本机就绪 | [Sol 协调器与安装步骤](docs/sol-coordinator.md) |
| 复用既有 WorkBuddy 安装、账户及项目授权 | [WorkBuddy DSF 项目入口](docs/workbuddy-project-entry.md) |
| 启用官方 CodeBuddy ACP 的 HY4 | [CodeBuddy ACP](docs/codebuddy-acp.md) |
| DSH 谷时治理及模式 2 实际峰时的 WorkBuddy 交接 | [峰谷调度](docs/offpeak-schedule.md) |
| 模式 3 中明确授权的 DSH → HY4 预准入回退 | [HY4 回退](docs/hy4-fallback.md) |
| Terra 专家任务（主机操作/验收、写作、绘图/图像） | [Terra 受保护入口](docs/terra-api.md) |

只部署 DSH 的电脑可以使用默认订阅 Sol → DSH、A 及所配日历的 DSH 时段。WorkBuddy 的注册检查在这类电脑上可以是 `false`。项目入口的模板使用只读示例。已经批准读写或命令的研究项目按实际授权设置一次，同一项目的后续论文、数据、脚本与任务直接随派单更换。 [项目权限设置](docs/workbuddy-project-entry.md#项目配置)

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
