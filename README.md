# ai_rule

两台 Windows 电脑共用的 Codex 调度规则、Skill 和本机 MCP 桥接器。Sol 主控默认使用 Codex 订阅，可按会话切换为独立 OpenAI Responses API。

## 已落地与尚未验收

| 项目 | 本仓库状态 |
|---|---|
| 跨会话全局规则、调度 Skill | 已实现，可安装；保留宿主安全策略 |
| 会话模式保持 | 已写入 AGENTS/Skill；同一会话省略模式时沿用，明确选择才切换；不是程序强制路由 |
| Astra → 真实 Sol → 外部执行 | 订阅路径由原生 Sol 实际派单。可选 API 路径由 Responses API Sol 调用本机执行适配器，离线测试验证编排，真实链路须本机验收 |
| Sol 协调来源 | 新会话默认 `subscription`，可单次或按会话切换 `api`。执行模式和峰谷选择独立，活动任务保留原协调器与执行后端 |
| 低开销等待 | r3 规则优先有界同步 run，必要异步使用最长有效 wait 并减少无变化汇报；代码未改，实际节省未量化 |
| 安装预览、合并、备份、冲突检测、回滚 | 已实现；不覆盖原有全局配置 |
| DSH 原生 headless stdio MCP | 已实现；同步/异步提交、等待、取消、回执、幂等、独占锁 |
| 同机 DSH 多实例 | 已实现；默认服务加命名服务，各自独立 runtime、锁、回执、幂等域和会话所有权；不自动按聊天身份注入路由 |
| WorkBuddy DSF 项目入口 | 可选迁移到同名 `deepseek-v4-flash-workbuddy`；固定 WorkBuddy `deepseek-v4-flash`，已批准项目内换论文、脚本和数据可直接派单；真实 WorkBuddy 验收在本机进行 |
| 已有 WorkBuddy 定制入口 | 默认保留 DSF 和 HY4 注册；可注册用户已准备好的完整桥接器；电脑 B 暂不部署 |
| DSH→HY4 预准入回退 | **已接入临时验证**：`bridges/dsh/routing.mjs` + opt-in endpoint；Windows 临时标准 stdio 中隔离 DSH 预准入拒绝后真实 HY4 native 文件任务已完成；每机注册/宿主加载仍需各自验收 |
| CodeBuddy ACP Hy4 适配器 | **可选实现并已临时验证**：`bridges/hy4/`，固定 `hy4free`；显式 `text-only`/`workspace-read`/`workspace-write`；写任务支持 canonical cwd、`writeScopes` 和可选精确 `writes`；每次 handshake/prompt 前要求 catalog 明示 `x0.00 credits`，缺失/非零 fail closed；目录价不是账单证明；未声明每机已注册 |
| Root chat DSH pool | **已实现并临时验证**：`bridges/pool/server.mjs` opt-in stdio MCP + 严格 handle/operation、按根 TaskManager/Hy4/Routing、host 父链与短期 context、running cap 3；Windows 临时标准 stdio 验证真实单根两任务和两个命名实例；未声明每机已注册/宿主已加载 |
| 原生 Sol/Luna 的模型 ID 和子代理配置 | 复用本机已有配置，不按角色名猜造 ID |
| 本机 DSH + Go 与 Codex 端到端验收 | 用户反馈两台电脑均通过文本/原生只读工具调用；未独立读取本机回执，不代表写入、长期监守或实际服务端型号已验收 |

默认 A：仅在全新会话尚未选择模式时启用，由 Sol Max 规划并执行，必要时 Luna 监守。
指定 HY4 / WorkBuddy DeepSeek / DSH：设为当前会话模式，Sol Max **只规划、调度、验收**；指定代理负责实际执行和自身监守，**不使用 Luna**。
后续消息不写模式时仍沿用当前选择，不会每轮恢复 A。Astra 负责总体方向。外部后端失败不得自动切回 Sol 或其他模型。唯一例外是本机显式启用、用户授权、结构化证明“未受理”的 DSH→HY4 预准入回退，最多一次；已受理/运行中/超时/断连/未知/权限/参数/busy/lock/停止均不回退。DSH 仍是默认；Windows 临时标准 stdio 已实际验证隔离 DSH 拒绝后的真实 HY4 native 文件任务，但每台机器的 MCP 注册/宿主加载仍需各自验收。详见 [docs/hy4-fallback.md](docs/hy4-fallback.md) 与 [docs/codebuddy-acp.md](docs/codebuddy-acp.md)。

订阅协调链路为 **Astra 主代理 → 真实 Sol Max（max）子代理 → DSH 或 WorkBuddy MCP → 原生执行 Harness**。HY4 与 WorkBuddy DeepSeek 同样由实际 Sol 协调子代理派单。订阅调度仍使用宿主真实 agent ID 验收。
API 协调链路为 **Codex 主会话 → 本机 sol-coordinator MCP → 独立 OpenAI Responses API Sol → DSH 根池或已授权 WorkBuddy DSF 桥接器**。API Sol 负责规划、派单、验收和修订，DSH 仍使用 `opencode-go / deepseek-v4.1-flash / max`。Windows 安装和真实 API 验证见 [Sol 协调来源](docs/sol-coordinator.md)。
**没有 OpenCode CLI / OpenCode Harness 这一层。** 主会话已经由宿主证实为 Sol 时不需要再套一个 Sol；Astra 不能模拟 Sol。
当前 HY4 文件工作契约：默认只读；`workspace-write` 必须本机显式启用、任务 `cwd`/`authorizationNote` 和 `writeScopes`/`writes` 授权；目录 scope 支持 `create`/`replace`/`edit`，精确文件支持 `create`/`edit`/`write`；不要求预计算内容，可选 hash 只用于 full-content write。命令源码保留但默认关闭。详见 [docs/codebuddy-acp.md](docs/codebuddy-acp.md)。

用户在 2026-11-10 提供的审计显示：真实 Sol 子代理已创建且能看到工具，但 Astra 直接提交了 DSH 任务。r2 针对这一调度缺口修正规则，不重新开发桥接器、不改变模型或权限，也不宣称仅改规则就保证调用链合规。详见 [docs/session-modes.md](docs/session-modes.md)。

## 等待策略：少唤醒，少重复汇报

r3 规范订阅 Sol 调用 DSH 工具时的等待：

| 情况 | Sol 的处理 |
|---|---|
| 新的有界任务，不需中途介入，已确认宿主单次工具超时覆盖任务预算与余量 | 优先 run_dsh_task，桥接器内部等待终态后返回 |
| 需要提前取得任务 ID、观察/取消，或宿主阻塞超时不足/未知 | start_dsh_task + wait_dsh_task |
| 已通过 start 启动的任务 | 保留原任务，不取消、不重提、不再用 run 转换；继续 wait |
| 异步等待，宿主允许足够时长 | 显式 waitMs=60000，正常 running 直接续等，不每次重述进度 |
| 完成、失败、超时、阻塞、审批、实质里程碑或用户询问 | 必要分析与汇报；不隐藏异常或忽视取消 |

Astra 在订阅路径用原生 wait 等真实 Sol agent ID，在 API 路径等待 `sol-coordinator` 的原协调任务。Sol 使用原后端的等待接口，在执行回执有变化时统一验收。
若宿主超时不容纳 60 秒等待，使用已核实限制内的最长值并说明一次。任务 timeoutMs 和单次 waitMs 不同；等待窗口结束不等于任务失败。
当前桥接器 wait 上限仍是 60000 ms，默认仍是 25000 ms；不能传五分钟等待参数。run 已有的内部循环不返回给 Sol，不需要本次修改源码。
本更新不保证零模型唤醒或固定 Token 降幅，也没有新增后台主动通知。详见 [docs/waiting-policy.md](docs/waiting-policy.md)。

## 电脑 A：已有 DSH 成功配置，直接安装

使用当前能运行 `dsh --profile headless` 的同一 Windows 用户。DSH 安装需要 Git 和 Node。WorkBuddy 项目入口的可选 SDK 单独安装。
Node 最低 22 是本仓库要求；DSH 自身可能要求更高版本，使用已经成功运行 DSH 的那套 Node。

```powershell
git clone https://github.com/isheach/ai_rule.git "$env:USERPROFILE\ai_rule"
Set-Location "$env:USERPROFILE\ai_rule"

# 预览：只探测 CLI/配置，不发起付费模型请求、不修改文件
.\scripts\install.ps1 -EnableDsh

# 核对后安装，DSH 默认工作区可写
.\scripts\install.ps1 -Apply -EnableDsh

# 检查持久化文件/注册情况；此处仍不是真实模型验收
.\scripts\install.ps1 -Verify
```

若系统策略阻止 `.ps1`，不必修改执行策略，直接运行等价的 Node 命令：

```powershell
node .\scripts\manage.mjs --enable-dsh
node .\scripts\manage.mjs --apply --enable-dsh
node .\scripts\manage.mjs --verify
```

安装器自动识别 npm 全局 DSH 的 JavaScript 入口、用户目录和 Node 路径。识别失败时用 `-DshEntry "实际的\@deepseek-ai\dsh\lib\bin.js"`；不要传 `.cmd` 或 `.ps1` shim。
它不会重新安装 DSH、修改 profile 或读取凭据文件；预检查会核实 headless 的配置路由与 JSON/权限选项。预检查不通过就停止。

首次安装且没有活动任务时，完全重启 Codex 并新开会话，再运行 `codex mcp list`。已有 HY4/WorkBuddy DeepSeek 配置不动。
已有任务仍在运行时，不为更新规则关闭宿主或原 MCP；采用下文的规则同步和显式重读流程。

### 同机多聊天：添加独立命名 DSH 实例

默认服务 `dsh-opencode-go` 保留旧 runtime 和旧回执。需要第二个、第三个独立任务域时，用受支持的安装器添加命名服务；不要手工复制 runtime，也不要只在本机加一个 Godot 别名冒充交付：

```powershell
# 预览：默认 + alpha + bravo；不写文件、不调用付费模型
.\scripts\install.ps1 -EnableDsh -DshInstance alpha,bravo

# 确认没有活动任务后安装；默认仍是只读
.\scripts\install.ps1 -Apply -EnableDsh -DshInstance alpha,bravo
.\scripts\install.ps1 -Verify
```

Node 等价写法可重复传 `--dsh-instance`：

```powershell
node .\scripts\manage.mjs --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --apply --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --verify
```

每个命名实例分别管理 runtime、锁、回执和会话所有权。同一实例串行，不同实例可并发。新增命名服务保留已有默认、WorkBuddy、HY4 和其他注册项。新 DSH 实例默认工作区可写，可用 `--read-only` 限制该实例。默认与命名实例按会话选择逐任务应用日历。`--verify` 验证安装器管理的注册块，手工服务列在 `unmanaged_dsh_services`。
并发优先使用根池。使用传统入口时，同一个 Sol 可以按用户要求把不同任务派给宿主可区分的已注册实例。派单前通过 `get_dsh_bridge_status` 核对 `instance` 和 `runtime`。同一任务的重试、续跑、查询、等待与取消都使用原实例。
跨实例 `get`/`wait`/`cancel` 会安全失败；断连后非所有者只能得到 `unknown_after_disconnect`，不能删锁或重跑。继续会话必须同实例、同 cwd 并使用该实例回执的 session_id。实例隔离不等于 DSH 凭据、账户、额度、会话存储或 OS 权限隔离。
完整规则、逐聊天工作流、跨电脑同步和排障见 [docs/multisession.md](docs/multisession.md)。

### 可选根池 MCP

订阅路径下，`dsh-root-pool` 注册并经宿主加载后，“使用 DSH”选择根池。显式指定的默认或命名服务仍按原入口使用。Sol 通过已注册服务旁的 `cli.mjs context` 取得当前根上下文，用它派单、查询、等待、取消和设置日程。同一 Sol 可在同一个根同时运行多个独立 DSH，机器级容量默认 3。普通任务默认工作区可写，新根默认关闭峰谷。注册、权限和生命周期见 [docs/root-pool.md](docs/root-pool.md)。

### 可选 API Sol 协调器

安装器可根据已有 DSH 设置生成本机配置，或沿用一个符合工作区和权限限制的现有根池。可选择显式本机 JSON 配置，并加入已授权的 WorkBuddy DSF 连接。安装预览、应用和结构验证均不调用模型，独立 API 访问在目标机器上显式验证。安装、回滚、变量名和例句见 [Sol 协调来源](docs/sol-coordinator.md)。

### 可选 WorkBuddy DSF 项目入口

用已安装的 WorkBuddy 和已批准的项目目录，一次配置 `deepseek-v4-flash-workbuddy`。此后 Sol 用同一个入口接收项目内的新论文、脚本、数据和其它任务，沿用已有读写及命令权限。模式 2 的实际峰时派发和显式 WorkBuddy DSF 共用该入口。是否使用 API Sol 由当前会话另行选择。 [本机迁移与验收](docs/workbuddy-project-entry.md)

### 第一次端到端验收

在 Codex 新会话输入：

> 本会话使用 DSH。这次验收请选择 dsh-opencode-go-alpha。Astra 创建或恢复真实 Sol 协调者。由 Sol 调用 get_dsh_bridge_status 确认 instance=alpha，再在已存在的空测试目录用 run_dsh_task 派文本测试，传入 permissionMode=read-only。提供协调者 ID、实际 MCP 发起方、任务 ID、退出码、final_reason 和回执。

使用已存在的绝对目录和本机实际注册的服务名。完成后可派一个只读文件任务，检查回执中的 native_tool_calls。
DSH 回执证明任务执行，不独立证明上游调用者；实际调用归属还须宿主记录。首次或换协调者时核实，日常保留最小证据，不反复扫描完整日志。

### 工作区权限

正常 DSH 任务默认使用 `workspace-write`，实际写入受用户授权、工作区和宿主权限约束。单任务用 `permissionMode: "read-only"`，也可注册只读服务。

```powershell
.\scripts\install.ps1 -Apply -EnableDsh -ReadOnly
```

根池可通过 `allow_write: false` 或注册 `--read-only` 设为只读。HY4 仍使用独立的任务能力和范围授权。

## 新会话怎么用：一次选择，持续沿用

在 Codex 会话输入框中发送，不是在 PowerShell 中执行：

```text
本会话使用 DSH 模式。读取当前生效的 AGENTS.md 和 multi-agent-dispatch Skill。
Astra 负责总体方向，默认用 gpt-6.2-sol（max）担任真实 Sol 协调者。Sol 在自己的上下文调用 DSH MCP，负责规划、等待、验收和修订派单。
DSH 负责实际执行、测试、修复及必要监守；Sol 不代执行，不使用 Luna，不经过 OpenCode CLI。
除非我明确切换模式，否则本会话后续任务一直沿用 DSH，不因我省略模式而恢复默认。
只有全新会话从未指定模式时才使用默认 A；指定模式不等于授权所有写入，继续遵守每个任务的授权范围。
遵守 low-overhead-wait-r3：可安全同步的有界任务优先 run_dsh_task，必须异步时使用最长有效 wait，没有新变化不反复汇报。
先简短确认当前模式与协调者。第一个任务：先只读分析当前项目结构。
```

之后可以直接说“继续”“修改方案”“分析下一个模块”，无需重复选 DSH。更短的开场也可以是：

> 本会话使用 DSH，由真实 Sol Max 子代理派单，按低开销等待规则工作；除非我明确切换，否则后续一直沿用。先只读分析当前项目。

| 用户表达 | 当前会话规则 |
|---|---|
| 全新会话直接布置任务，未选择模式 | 默认 A，由 Sol Max 执行 |
| “使用 DSH，分析……” | 将 DSH 设为会话模式，后续省略模式仍保持 |
| “Sol 主控切到 API” | 后续任务由 API Sol 协调，执行模式和峰谷选择继续沿用 |
| “Sol 主控切回订阅” | 后续任务由订阅 Sol 协调，已有任务由原协调器处理 |
| “仅本次由 API Sol 主控” | 仅当前任务切换来源，后续沿用原会话设置 |
| “切换为原生方案 A” | 后续使用 A |
| “仅本次用 HY4” | 仅该任务例外，结束后回到原模式；后端须已部署且可用 |
| “HY4 比 DSH 好吗？” | 只是讨论，不切换 |
| 已选 DSH，但 DSH 报错或不可用 | 默认报告阻塞、保留选择；仅“未受理”的日程/受支持预准入探测且本机显式授权、HY4 已验证时，可按策略转一次 |

全新会话未指定时采用 A / `subscription`。恢复原会话时保留有证据的原执行模式和协调来源。
详细规则、旧任务交接与手工验收场景见 [docs/session-modes.md](docs/session-modes.md)；r3 等待补充见 [docs/waiting-policy.md](docs/waiting-policy.md)。CodeBuddy ACP 适配器见 [docs/codebuddy-acp.md](docs/codebuddy-acp.md)；可选的根池 MCP 见 [docs/root-pool.md](docs/root-pool.md)。

规则安装到有效的全局 AGENTS 文件，Skill 安装到 `~/.agents/skills/multi-agent-dispatch`。若存在非空 `AGENTS.override.md`，合并到这个实际生效的文件，不另写一份被忽略的 AGENTS。
文件只是持久行为规则，不会凭空增加模型权限或强制宿主实现不存在的子代理能力；项目级规则和当前指令仍可能影响行为，需实际调用验收。

## 电脑 B：当前只部署 DSH

克隆同一仓库即可复用代码和规则，不需要重新写长提示词。机器环境和认证不会被 Git 自动同步。

先安装规则：`.\scripts\install.ps1 -Apply`。
待电脑 B 自己的 DSH、Go 凭据、headless 路由和会话插件准备好并测试通过，再运行 `-Apply -EnableDsh`；需要同一套命名实例时按 [docs/multisession.md](docs/multisession.md) 的同步命令执行。参考 `config/headless.patch.example.yml`，不要覆盖现有 profile。
按用户当前选择，电脑 B **暂不部署 WorkBuddy**；两个 `workbuddy_*_registered: false` 不影响已注册的 DSH。不自动安装 WorkBuddy，也不因缺少它们改变默认 A 或 DSH 会话选择。
今后用户明确需要时，可在 B 用本机 WorkBuddy 和已批准的目录部署项目入口，或用已准备的完整定制桥接器。私有凭据及绝对路径在各机器保留。 [WorkBuddy 桥接器](bridges/workbuddy/README.md)

## 更新、回滚与测试

### 仅同步规则和 Skill

在需要更新的每台电脑执行：

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Git 同步失败，停止安装；不要强制覆盖本地修改。" }
node .\scripts\manage.mjs
if ($LASTEXITCODE -ne 0) { throw "预览失败，停止安装。" }
# 预览应只有 AGENTS 和 Skill；确认后再执行。
node .\scripts\manage.mjs --apply
if ($LASTEXITCODE -ne 0) { throw "规则安装失败。" }
node .\scripts\manage.mjs --verify
```

运行无选项的预览、应用命令时，仅更新规则和 Skill。已有 MCP、权限配置和 DSH profile 继续使用原注册。WorkBuddy 项目入口与 Sol MCP 使用各自的注册选项。同步前确认远端没有超出预期范围的额外代码变更；意外改动 bridges/scripts 时停止并评估活动任务。 [WorkBuddy 项目入口](docs/workbuddy-project-entry.md) · [Sol 配置](docs/sol-coordinator.md)

**有活动任务时不要立即重启 Codex。** 在旧会话明确要求 Astra 与 Sol 分别读取更新后的有效 AGENTS 和 Skill；保留原 MCP 生命周期，按 Skill 交接现有任务，不重复提交。没有活动任务后，再重启或新建会话检查启动加载。远端提交和本地安装都不会自动重写已有会话上下文。

### 同时更新 MCP 注册配置

```powershell
git pull --ff-only
.\scripts\install.ps1 -EnableDsh
.\scripts\install.ps1 -Apply -EnableDsh
npm test
```

显式只读配置在重建同一个托管服务时保留，可使用 `-AllowWrite` 恢复该服务的工作区可写模式。仅同步规则无需更新 MCP 注册。
安装会输出本机回滚 manifest 路径。用 `.\scripts\install.ps1 -RollbackManifest "该路径"` 回滚。文件在安装后又被修改时，回滚拒绝覆盖，需手工合并。
备份保存在 Codex home 的 `ai-rule-backups`，可能包含已有配置中的秘密，仅保留本机，禁止上传。

测试、权限边界和恢复说明见 [docs/implementation.md](docs/implementation.md)。其中 2026-11-09 的开发验收记录是当时状态，不应与后续用户反馈混为一谈。隔离 mock 全通过；Windows 临时标准 stdio 另由 Sol 验证同一真实根两任务、alpha/bravo 真实实例重叠、真实 HY4 文件任务和一次授权命令。每台机器的注册/宿主加载、真实多聊天 identity、OS 隔离与 Token 节省仍须各自验收。

## DSH 峰谷时段控制

用户可以说“本会话用峰谷模式 2”来选择 DSH 调度。模式 1 无峰谷且是默认值。模式 2 谷时用 DSH，实际峰时的新任务由 Sol 领取一次性派发并调用已部署的 WorkBuddy DSF。模式 3 延续原峰谷规则和原有的可选 HY4 回退。“关闭峰谷”和“开启峰谷”分别选 1 和 3。

根池用 `set_pool_schedule` 保存 `scheduleMode`。默认和命名服务由 Sol 保存会话选项，每次派单传 `scheduleMode`，用 `set_dsh_task_schedule` 更新本会话正在运行的 DSH。旧布尔参数仍可用。默认峰时为工作日中国/新加坡时间 **09:00–12:00、14:00–18:00**。峰时停止的 DSH 保持原终态，WorkBuddy 未部署时只阻塞模式 2 的峰时任务。详见 [峰谷调度](docs/offpeak-schedule.md)。
