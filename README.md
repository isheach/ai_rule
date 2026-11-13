# ai_rule

两台 Windows 电脑共用的 Codex 调度规则、Skill 和 DSH MCP 桥接器。桥接器/安装器版本 **v0.3.0**；规则修订 **2026-11-12.dsh-multisession-r1**。

## 已落地与尚未验收

| 项目 | 本仓库状态 |
|---|---|
| 跨会话全局规则、调度 Skill | 已实现，可安装；保留宿主安全策略 |
| 会话模式保持 | 已写入 AGENTS/Skill；同一会话省略模式时沿用，明确选择才切换；不是程序强制路由 |
| Astra → 真实 Sol → 外部 MCP | 已补全实际调用者规则、证据与交接流程；不是技术工具隔离，真实链路须本机验收 |
| 低开销等待 | r3 规则优先有界同步 run，必要异步使用最长有效 wait 并减少无变化汇报；代码未改，实际节省未量化 |
| 安装预览、合并、备份、冲突检测、回滚 | 已实现；不覆盖原有全局配置 |
| DSH 原生 headless stdio MCP | 已实现；同步/异步提交、等待、取消、回执、幂等、独占锁 |
| 同机 DSH 多实例 | 已实现；默认服务加命名服务，各自独立 runtime、锁、回执、幂等域和会话所有权；不自动按聊天身份注入路由 |
| WorkBuddy 两个入口 | 原样保留；可注册用户已准备好的完整桥接器；电脑 B 暂不部署 |
| DSH→HY4 预准入回退 | **已接入临时验证**：`bridges/dsh/routing.mjs` + opt-in endpoint；Windows 临时标准 stdio 中隔离 DSH 预准入拒绝后真实 HY4 native 文件任务已完成；每机注册/宿主加载仍需各自验收 |
| CodeBuddy ACP Hy4 适配器 | **可选实现并已临时验证**：`bridges/hy4/`，固定 `hy4free`；显式 `text-only`/`workspace-read`/`workspace-write`；写任务支持 canonical cwd、`writeScopes` 和可选精确 `writes`；每次 handshake/prompt 前要求 catalog 明示 `x0.00 credits`，缺失/非零 fail closed；目录价不是账单证明；未声明每机已注册 |
| Root chat DSH pool | **已实现并临时验证**：`bridges/pool/server.mjs` opt-in stdio MCP + 严格 handle/operation、按根 TaskManager/Hy4/Routing、host 父链与短期 context、running cap 3；Windows 临时标准 stdio 验证真实单根两任务和两个命名实例；未声明每机已注册/宿主已加载 |
| 现有 WorkBuddy 自定义源码迁移 | **未做**：当前不能读取用户本机完整源码，不能重建授权模块 |
| 原生 Sol/Luna 的模型 ID 和子代理配置 | 复用本机已有配置，不按角色名猜造 ID |
| 本机 DSH + Go 与 Codex 端到端验收 | 用户反馈两台电脑均通过文本/原生只读工具调用；未独立读取本机回执，不代表写入、长期监守或实际服务端型号已验收 |

默认 A：仅在全新会话尚未选择模式时启用，由 Sol Max 规划并执行，必要时 Luna 监守。
指定 HY4 / WorkBuddy DeepSeek / DSH：设为当前会话模式，Sol Max **只规划、调度、验收**；指定代理负责实际执行和自身监守，**不使用 Luna**。
后续消息不写模式时仍沿用当前选择，不会每轮恢复 A。Astra 负责总体方向。外部后端失败不得自动切回 Sol 或其他模型。唯一例外是本机显式启用、用户授权、结构化证明“未受理”的 DSH→HY4 预准入回退，最多一次；已受理/运行中/超时/断连/未知/权限/参数/busy/lock/停止均不回退。DSH 仍是默认；Windows 临时标准 stdio 已实际验证隔离 DSH 拒绝后的真实 HY4 native 文件任务，但每台机器的 MCP 注册/宿主加载仍需各自验收。详见 [docs/hy4-fallback.md](docs/hy4-fallback.md) 与 [docs/codebuddy-acp.md](docs/codebuddy-acp.md)。

DSH 路径：**Astra 主代理 → 真实 Sol Max（max）子代理 → dsh-opencode-go MCP → DSH 原生 Harness → OpenCode Go 模型 API**。
HY4 与 WorkBuddy DeepSeek 同样必须由真实 Sol 协调子代理调用；创建 Sol 却由 Astra 转发 MCP 不合格。
**没有 OpenCode CLI / OpenCode Harness 这一层。** 主会话已经由宿主证实为 Sol 时不需要再套一个 Sol；Astra 不能模拟 Sol。
当前 HY4 文件工作契约：默认只读；`workspace-write` 必须本机显式启用、任务 `cwd`/`authorizationNote` 和 `writeScopes`/`writes` 授权；目录 scope 支持 `create`/`replace`/`edit`，精确文件支持 `create`/`edit`/`write`；不要求预计算内容，可选 hash 只用于 full-content write。命令源码保留但默认关闭。详见 [docs/codebuddy-acp.md](docs/codebuddy-acp.md)。

用户在 2026-11-10 提供的审计显示：真实 Sol 子代理已创建且能看到工具，但 Astra 直接提交了 DSH 任务。r2 针对这一调度缺口修正规则，不重新开发桥接器、不改变模型或权限，也不宣称仅改规则就保证调用链合规。详见 [docs/session-modes.md](docs/session-modes.md)。

## 等待策略：少唤醒，少重复汇报

r3 保留上述实际调用链和会话模式规则，只调整现有接口的使用策略：

| 情况 | Sol 的处理 |
|---|---|
| 新的有界任务，不需中途介入，已确认宿主单次工具超时覆盖任务预算与余量 | 优先 run_dsh_task，桥接器内部等待终态后返回 |
| 需要提前取得任务 ID、观察/取消，或宿主阻塞超时不足/未知 | start_dsh_task + wait_dsh_task |
| 已通过 start 启动的任务 | 保留原任务，不取消、不重提、不再用 run 转换；继续 wait |
| 异步等待，宿主允许足够时长 | 显式 waitMs=60000，正常 running 直接续等，不每次重述进度 |
| 完成、失败、超时、阻塞、审批、实质里程碑或用户询问 | 必要分析与汇报；不隐藏异常或忽视取消 |

Astra 继续原生 wait 等真实 Sol agent ID，不直接查询 DSH。Sol 不因每个等待窗口到期就重新推演验收计划，也不额外 get/status 或发送催问。
若宿主超时不容纳 60 秒等待，使用已核实限制内的最长值并说明一次。任务 timeoutMs 和单次 waitMs 不同；等待窗口结束不等于任务失败。
当前桥接器 wait 上限仍是 60000 ms，默认仍是 25000 ms；不能传五分钟等待参数。run 已有的内部循环不返回给 Sol，不需要本次修改源码。
本更新不保证零模型唤醒或固定 Token 降幅，也没有新增后台主动通知。详见 [docs/waiting-policy.md](docs/waiting-policy.md)。

## 电脑 A：已有 DSH 成功配置，直接安装

使用当前能运行 `dsh --profile headless` 的同一 Windows 用户。需要 Git、Node；本仓库无第三方 npm 依赖，不必 `npm install`。
Node 最低 22 是本仓库要求；DSH 自身可能要求更高版本，使用已经成功运行 DSH 的那套 Node。

```powershell
git clone https://github.com/isheach/ai_rule.git "$env:USERPROFILE\ai_rule"
Set-Location "$env:USERPROFILE\ai_rule"

# 预览：只探测 CLI/配置，不发起付费模型请求、不修改文件
.\scripts\install.ps1 -EnableDsh

# 查看预览无误后安装：默认只读 DSH 执行
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

每个命名实例有自己的 runtime、`active.lock`、任务回执、幂等域、会话所有权和状态身份；不同实例可并行，同一实例仍单任务互斥。安装器保留默认、WorkBuddy/HY4 和无关服务；在已有默认服务上新增命名服务不会重写默认服务，默认的 `--runtime`、`--allow-write` 和自定义 `--schedule-config` 原样保留，新命名实例默认只读并继承默认的日程配置。要显式改默认服务（含改回只读、换 runtime 或改日程）时，使用不带 `--dsh-instance` 的 `--enable-dsh` 命令；在已有默认服务上新增实例时夹带日程变更会被拒绝。`--verify` 只验证 ai_rule managed 块，未管理的同名/手工服务会显示在 `unmanaged_dsh_services` 中但不被改写。
每个聊天在会话中固定一个 MCP 服务（如 `dsh-opencode-go-alpha`），由真实 Sol 调用该服务的工具，并先核对 `get_dsh_bridge_status` 的 `instance`/`runtime`。stdio MCP 没有可靠的自动聊天身份，本仓库不假定 `CODEX_THREAD_ID` 等变量，也不把提示词或 caller 字段当认证；若宿主无法区分多个实例工具，需使用其支持的服务器作用域/独立 profile，或报告限制。
跨实例 `get`/`wait`/`cancel` 会安全失败；断连后非所有者只能得到 `unknown_after_disconnect`，不能删锁或重跑。继续会话必须同实例、同 cwd 并使用该实例回执的 session_id。实例隔离不等于 DSH 凭据、账户、额度、会话存储或 OS 权限隔离。
完整规则、逐聊天工作流、跨电脑同步和排障见 [docs/multisession.md](docs/multisession.md)。

### 可选根池 MCP：同一根聊天复用 pooled runtime

`bridges/pool/server.mjs` 是额外、opt-in stdio MCP，保留现有注册/日程/数据和 v0.3 入口。Windows 临时标准 stdio 已用一个真实根、两个批准 cwd 的 DSH 任务和两个真实命名实例验证；独立合成根仅用 mock stdio。**本机注册 `dsh-root-pool`、受支持 reload 且工具可见后，用户说“使用 DSH”或同义选择即选择根池，不需要 root/instance 名**；显式指定命名旧服务仍走旧服务，未安装根池的电脑继续原 DSH，已启动任务保持原后端。Sol 在自己的宿主 shell 先运行 `codex mcp get dsh-root-pool --json`，只取 `transport.command/args`，用已注册 server 旁的 `cli.mjs` 和同一 `--config` 运行 `context`，把 opaque context 交给 `start/run/get/wait/cancel_pool_task`；不要打印完整 config/env，不要手写 rootId/实例名/lease，stdio 参数不是身份认证。默认只读，running cap 3，schedule 必须显式启用且不自动恢复；HY4 仅在结构化预准入拒绝且本机显式授权/ready 时最多一次。注册示例、`tool_timeout_sec=3700`（实际宿主可不同）与限制见 [docs/root-pool.md](docs/root-pool.md)。未声明每台机器已注册/宿主已加载，也不宣称 OS 隔离或 provider 计费。

### 第一次端到端验收

在 Codex 新会话输入：

> 本会话使用 DSH，固定使用 MCP 服务 dsh-opencode-go-alpha。Astra 先创建或恢复真实 Sol Max（max）子代理，由该子代理先调用该服务的 get_dsh_bridge_status，确认 instance=alpha，再在已存在的空测试目录中用 run_dsh_task 做只读文本测试。提供协调者 ID、实际 MCP 发起方依据、任务 ID、退出码、final_reason 和回执。Astra 不转发，Sol 不代执行，不用模型自我介绍证明身份。

目录必须是真实绝对路径。只有一个默认实例时，去掉“固定使用 MCP 服务 …”；多实例聊天各自把示例服务名换成实际注册名。完成后再批准一个读取测试文件的任务，核实回执中的 native_tool_calls，而不是立刻开始真实项目写入。
DSH 回执证明任务执行，不独立证明上游调用者；实际调用归属还须宿主记录。首次或换协调者时核实，日常保留最小证据，不反复扫描完整日志。

### 开放经批准的工作区写入

默认是只读。完成验收并决定让 DSH 做代码修改时，显式运行：

```powershell
.\scripts\install.ps1 -Apply -EnableDsh -AllowWrite
```

这只允许 MCP 接受 workspace-write 请求；每次任务仍需对应用户授权，传入 authorizationNote。它不是永久授权所有写入，更不授权安装、删除、提交或推送。宿主审批规则不修改。
若要恢复只读，再执行不带 `-AllowWrite` 的安装命令；需要重启时先确认没有活动任务。

## 新会话怎么用：一次选择，持续沿用

在 Codex 会话输入框中发送，不是在 PowerShell 中执行：

```text
本会话使用 DSH 模式。读取当前生效的 AGENTS.md 和 multi-agent-dispatch Skill。
Astra 负责总体方向，并创建或恢复真实 Sol Max（max）子代理；由 Sol 在自己的上下文实际调用 DSH MCP，负责规划、等待、验收和修订派单。Astra 不直接调用 DSH，也不把 Sol 只当顾问。
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
| “切换为原生方案 A” | 后续使用 A |
| “仅本次用 HY4” | 仅该任务例外，结束后回到原模式；后端须已部署且可用 |
| “HY4 比 DSH 好吗？” | 只是讨论，不切换 |
| 已选 DSH，但 DSH 报错或不可用 | 默认报告阻塞、保留选择；仅“未受理”的日程/受支持预准入探测且本机显式授权、HY4 已验证时，可按策略转一次 |

全新会话未指定时仍为 A，不自动继承另一会话或另一台电脑的模式。恢复原会话时保留有证据的原选择。
详细规则、旧任务交接与手工验收场景见 [docs/session-modes.md](docs/session-modes.md)；r3 等待补充见 [docs/waiting-policy.md](docs/waiting-policy.md)。CodeBuddy ACP 适配器见 [docs/codebuddy-acp.md](docs/codebuddy-acp.md)；可选的根池 MCP 见 [docs/root-pool.md](docs/root-pool.md)。

规则安装到有效的全局 AGENTS 文件，Skill 安装到 `~/.agents/skills/multi-agent-dispatch`。若存在非空 `AGENTS.override.md`，合并到这个实际生效的文件，不另写一份被忽略的 AGENTS。
文件只是持久行为规则，不会凭空增加模型权限或强制宿主实现不存在的子代理能力；项目级规则和当前指令仍可能影响行为，需实际调用验收。

## 电脑 B：当前只部署 DSH

克隆同一仓库即可复用代码和规则，不需要重新写长提示词。机器环境和认证不会被 Git 自动同步。

先安装规则：`.\scripts\install.ps1 -Apply`。
待电脑 B 自己的 DSH、Go 凭据、headless 路由和会话插件准备好并测试通过，再运行 `-Apply -EnableDsh`；需要同一套命名实例时按 [docs/multisession.md](docs/multisession.md) 的同步命令执行。参考 `config/headless.patch.example.yml`，不要覆盖现有 profile。
按用户当前选择，电脑 B **暂不部署 WorkBuddy**；两个 `workbuddy_*_registered: false` 不影响已注册的 DSH。不自动安装 WorkBuddy，也不因缺少它们改变默认 A 或 DSH 会话选择。
今后用户明确需要时，才准备 WorkBuddy CLI 和完整定制桥接器；见 `bridges/workbuddy/README.md`。本仓库不会把 A 的私有凭据或绝对路径复制到 B。

## 更新、回滚与测试

### 仅同步规则和 Skill（适用于本次等待策略修订）

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

不带 `--enable-dsh` 或 `--workbuddy-bridge` 时，仅更新规则和 Skill；不删除已有 DSH MCP，不重写 config.toml，也不改变已有 AllowWrite 设置、凭据或 DSH Profile。安装器与桥接器版本现统一为 v0.3.0；仅更新规则时不会改动 MCP 注册。同步前确认远端没有超出预期范围的额外代码变更；意外改动 bridges/scripts 时停止并评估活动任务。

**有活动任务时不要立即重启 Codex。** 在旧会话明确要求 Astra 与 Sol 分别读取更新后的有效 AGENTS 和 Skill；保留原 MCP 生命周期，按 Skill 交接现有任务，不重复提交。没有活动任务后，再重启或新建会话检查启动加载。远端提交和本地安装都不会自动重写已有会话上下文。

### 同时更新 MCP 注册配置

```powershell
git pull --ff-only
.\scripts\install.ps1 -EnableDsh
.\scripts\install.ps1 -Apply -EnableDsh
npm test
```

已经启用写入的电脑，在重写 MCP 配置时明确带上 `-AllowWrite`；省略则恢复只读。仅同步规则的上一组命令不改变这个设置。
安装会输出本机回滚 manifest 路径。用 `.\scripts\install.ps1 -RollbackManifest "该路径"` 回滚。文件在安装后又被修改时，回滚拒绝覆盖，需手工合并。
备份保存在 Codex home 的 `ai-rule-backups`，可能包含已有配置中的秘密，仅保留本机，禁止上传。

测试、权限边界和恢复说明见 [docs/implementation.md](docs/implementation.md)。其中 2026-11-09 的开发验收记录是当时状态，不应与后续用户反馈混为一谈。隔离 mock 全通过；Windows 临时标准 stdio 另由 Sol 验证同一真实根两任务、alpha/bravo 真实实例重叠、真实 HY4 文件任务和一次授权命令。每台机器的注册/宿主加载、真实多聊天 identity、OS 隔离与 Token 节省仍须各自验收。

## DSH 峰谷时段控制（可选，默认关闭）

工作日中国/新加坡时间 **09:00–12:00、14:00–18:00** 为 Go DeepSeek 峰时，周末谷时。需在无 DSH 活动任务时显式启用：

```powershell
node .\scripts\manage.mjs --enable-dsh --offpeak-schedule
node .\scripts\manage.mjs --apply --enable-dsh --offpeak-schedule
```

如果此前 DSH 已启用写入，须在安装命令中另外保留 `--allow-write`；**时段控制本身不授权写入**。重启 Codex 后用 `get_dsh_schedule_status` 检查 `enabled=true`。提前 10 分钟停派新任务；若遇峰时，当前桥接器拥有的 DSH 本地进程尽力停工；默认**不自动恢复**，强制停止存在未保存进度风险。参见 [详细说明](docs/offpeak-schedule.md)。
