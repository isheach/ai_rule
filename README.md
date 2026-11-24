# ai_rule

默认 `entryStructure: "astra"` 下，Astra 明确目标、授权范围和验收条件后交接任务，等待所属 Sol 或 Terra 的完成确认后据此向用户汇报。全新独立会话默认由订阅的 GPT-6.2 Sol Max 规划、派发和验收，底层用 DSH/OpenCode Go DSF。主机操作、验收、绘图与图像生成或识别由同一来源的 GPT-6.1 Terra Max 承担。宿主配置反重力后，新文本写作默认走 Antigravity CLI。用户也可选择由真实宿主直接进入 Sol 的 `entryStructure: "sol"`；缺少实际直连能力时报告不可用。[入口结构与证据](docs/entry-structure.md) · [AGENTS.md](AGENTS.md) · [multi-agent dispatch Skill](skills/multi-agent-dispatch/SKILL.md)。

| 会话设置 | 全新会话默认 | 可选项 |
|---|---|---|
| 入口结构 | `astra` | `astra`、`sol` |
| Sol 协调来源 | Codex 订阅 | 订阅、受保护 OpenAI Responses API |
| 中间层模型 | GPT-6.2 Sol Max | 直接专家任务使用 GPT-6.1 Terra Max，Sol 可调用 Terra 或 GPT-6 Luna Max 协作 |
| 底层执行 | DSH/OpenCode Go DSF | A 原生、DSH、WorkBuddy DSF、HY4 |
| DSH 峰谷 | 1 无峰谷 | 1 无峰谷、2 实际峰时用 WorkBuddy DSF、3 原峰谷 |

全新默认只用于独立新会话。已有的入口结构、A/外部模式、模式 3、来源、已受理任务和所有者沿用原记录。A 由原生 Sol 执行，外部模式由所选 Harness 执行和监守，WorkBuddy DSF 是底层显式替代。订阅来源由 Sol 自己调用宿主提供的 Terra 或 Luna 代理，API 来源由 API Sol 调用 `delegate_peer`。三者继承同一项目和父任务的读写、命令、约束及预算，实际动作随所选入口的能力生效。 [会话操作](docs/session-modes.md)

Terra 的动作类专家任务使用与 Sol 相同的中间来源。主机操作、验收和图像任务通过实际提供的 CUA、图像工具或项目预注册动作完成。反重力仅接收明确授权的文本，模型别名由宿主管理并支持热更新。现有 Terra 写作仍可显式选择。 [反重力配置和模型目录](docs/antigravity-text.md)

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

Sol、Terra 与 Luna API 共用同一 Windows 项目、broker 和每小时配额。新装为 100 次/小时，缺少 `requests_per_hour` 的旧策略仍为 24，已有显式值保留。用固定修订的 `setup-sol.ps1 -EnableLunaApi` 预览，核对后加 `-Apply` 启用 Luna，沿用原密钥和滚动配额。服务运行时须等在途调用结束并显式使用 `-AllowBriefRestart`。订阅及 OpenCode Go/WorkBuddy 的额度按各自渠道计。 [启用 Luna API](docs/sol-coordinator.md#启用-luna-api) · [共享配额](docs/sol-coordinator.md#api-配额)

在目标 Windows 机核对安装结构，再按实际 Codex 宿主支持的方式加载，由真实 Sol 确认工具可用。已有任务先由原入口收尾。下一项已批准的任务可以核验真实调用者、任务回执和结果。若当前只具备云端源码入口，先完成代码和离线检查，目标机接入以本机证据另行核验。 [安装验收](docs/implementation.md)

## 可选入口

| 需要 | 设置说明 |
|---|---|
| 同一根会话并行多个独立 DSH 任务 | [DSH 根池](docs/root-pool.md) |
| 宿主按 MCP 服务分配多个独立 DSH 实例 | [DSH 命名实例](docs/multisession.md) |
| 设置订阅或 API 来源，启用 Luna 或 Terra API 并检查本机就绪 | [Sol 协调器与安装步骤](docs/sol-coordinator.md) |
| 复用既有 WorkBuddy 安装、账户及项目授权 | [WorkBuddy DSF 项目入口](docs/workbuddy-project-entry.md) |
| 启用官方 CodeBuddy ACP 的 HY4 | [CodeBuddy ACP](docs/codebuddy-acp.md) |
| DSH 谷时治理及模式 2 实际峰时的 WorkBuddy 交接 | [峰谷调度](docs/offpeak-schedule.md) |
| 模式 3 中明确授权的 DSH → HY4 预准入回退 | [HY4 回退](docs/hy4-fallback.md) |
| 反重力文本写作及模型目录 | [Antigravity CLI 文本入口](docs/antigravity-text.md) |
| Terra 专家任务（主机操作、验收、绘图及图像） | [Terra 受保护入口](docs/terra-api.md) |

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

会话内继续已有工作时，让原任务的协调者与接手者重读已安装规则；直接 Sol 入口由真实宿主与原 Sol 接续。现有任务先保留原进程和权限。更新桥接源码或注册后，在任务取得终态时通过宿主支持的方式加载相关服务一次，再确认工具可见。同一已批准项目里的任务输入变更直接随派单传入。

应用命令输出本机备份 `manifest.json`，可用 `node $manage --rollback $manifest` 回滚，传入该 manifest 的绝对路径。安装后又修改过的目标需按哈希冲突提示核对并合并。备份留在本机。离线回归用 `npm.cmd --prefix $sourceRoot test`。 [实现边界与验收](docs/implementation.md)
