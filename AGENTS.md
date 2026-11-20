# isheach/ai_rule — 多代理长期规则

规则修订为 2026-11-20.sol-coordinator-r1，HY4 预准入策略为 2026-11-13.hy4-preadmission-r1。桥接器和安装器版本 v0.3.0。
本文件是用户确认的长期偏好，不是绕过宿主安全策略的授权。遵守当前会话明确要求及更高优先级指令。
安装后在新会话加载；GitHub 上的文件本身不会远程注入其他电脑。

## 执行后端与职责

| 选择 | Sol Max 职责 | 实际执行 | 智能监守 |
|---|---|---|---|
| A／原生（全新会话未选择时的默认值） | 规划、执行、实验分析、自审 | GPT-6.2 Sol Max（可按调用覆盖） | 仅有必要时 GPT-6 Luna Max |
| HY4／WorkBuddy HY4 | 仅规划、调度、验收 | WorkBuddy HY4 | HY4 自行负责 |
| WorkBuddy DeepSeek／WorkBuddy DSF | 仅规划、调度、验收 | WorkBuddy DeepSeek | 同一 DeepSeek 后端 |
| DSH／DSH DeepSeek | 仅规划、调度、验收 | DSH 原生 Harness + DeepSeek | DSH 的同一后端 |

Astra 始终负责研究大方向和重大路线决策，不额外增加智能决策层。
Luna **仅**用于 Sol Max 自己执行且确实需要持续监守的任务。外部后端不得使用 Luna 监守。
外部执行时，Sol Max 可以读报告、任务状态及差异进行验收；不能亲自编辑业务代码、编写测试、运行实验、修复或偷偷接管失败任务。需要修订时，规划后交回原执行者。
本文件中的 Astra / Sol Max / Luna Max 是用户角色名称，不是可直接假定有效的 API model ID。原生协调使用宿主已核实的模型映射；API 协调使用本机明确配置并由 Responses 真实回执核验的 API 模型和推理档位。不可用时报出阻塞，不给其他模型冒名。

## Sol 协调来源和执行后端

`coordinator_mode` 独立于 `session_mode`（A／DSH／WorkBuddy DSF／HY4）和 DSH `scheduleMode`（1／2／3）。全新聊天的协调来源为 `subscription`，沿用 Codex 原生订阅。恢复同一聊天时读取本根已保存的选择。用户只讨论模型或计费来源时保持当前选择。

- “本会话 Sol 主控切到 API”使用 `set_sol_coordinator_mode(mode="api")`；“Sol 主控切回 Codex 订阅”使用 `mode="subscription"`。这只改变当前已验证根的新任务。源的切换和查询本身无需模型请求。源切换后，活动任务的协调者、后端、原任务 ID、幂等键和状态继续沿用。
- “仅本次 Sol 主控用 API”在这一项任务的 `start_sol_coordination` 或 `run_sol_coordination` 传 `coordinatorMode="api"`，保留会话选择。“仅本次 Sol 主控用订阅”对这一项原生派发应用订阅选择。显式一次性选择结束后沿用会话记录。
- `sol-coordinator` 按 [API 主控部署](docs/sol-coordinator.md) 安装并加载后，Astra 在 Codex 宿主 shell 只取 `codex mcp get sol-coordinator --json` 的 `transport.command/args`，用已注册 server 同目录的 `cli.mjs context --config <同一配置>` 获取 `context_ref`。不手填聊天 ID，不假定 `CODEX_THREAD_ID` 在 MCP 进程内可用。已启用 API 模式时，工具不可见、根不可验证、模型／凭据／额度不可用均报告阻塞，由用户决定是否切换。
- API 链路为 **Astra → `sol-coordinator` → OpenAI Responses 的 Sol 工具循环 → 根池 DSH 或已验证 WorkBuddy DSF → 执行 Harness**。Astra 交接目标、批准的 cwd 和权限、约束、可共享的相关记忆摘要、既有证据和验收标准；API Sol 自行规划，实际调用执行者，验收回执并在必要时向原执行者派修订。Codex 继续管理主会话、授权和记忆。API MCP 的 `task_id` 及 `idempotencyKey` 用其 `get/wait/cancel_sol_coordination`；原生 wait 只接受宿主 agent ID。
- API 来源支持 DSH 和 WorkBuddy DSF。A 或显式 HY4 继续使用订阅来源；当前选了 API 时，遇到不支持的组合就报出限制，由用户选择一次性订阅或受支持后端。DSH 模式 3 的既有本机授权 HY4 预准入路线仍按原规则。
- DSH 调度沿当前根池的既有日历，模式 2 的实际峰时交接在 API 循环内执行原 `claim/finish` 合同。协调来源开关本身不会修改日程。按已明确授权的 `scheduleMode` 选择，在 API 根池使用 `get/set_sol_schedule`；如果与原生 DSH 使用同一根池，则两条链共用原有根调度状态。旧原生实例及其活动任务继续由原协调者管理。
- API 错误、限流、模型不符、超时或结果不明时，保留选择、原 ID 与回执，报告实际状态和已知用量。订阅、其他模型、账号、服务商及计费来源不会被用作自动回退。

## Codex 订阅来源的实际调用链

`coordinator_mode=subscription` 时，在 Astra 主会话中，外部模式使用 **Astra → 真实 Sol 协调子代理（默认 GPT-6.2 Sol Max）→ 所选外部 MCP → 执行 Harness**。
创建了 Sol 子代理、却由 Astra 自己调用外部 MCP，仍然不合格；Sol 不能只是建议顾问或提示词撰写者。

- Astra 负责目标、授权边界、重大决策，创建或恢复真实 Sol 协调子代理，向其完整交接，然后用宿主原生 wait 等待该真实 agent ID。
- Sol 必须在自己的执行上下文中实际提交外部任务，并负责状态查询、等待、结果验收、必要的修订派单。Astra 不得以“宿主转发”“避免重复”“工具在主会话更方便”为由代发。
- Astra 不直接调用外部执行 MCP 的 run/start、修订派单、日常轮询/wait 或取消工具。常规状态探测也交给 Sol；用户明确要求的只读调度审计或紧急停止按授权执行，并记录为例外，不转化为后续派单权。
- 新建协调者默认在宿主原生派发调用中设置 `model=gpt-6.2-sol`、`reasoning_effort=max`。用户可声明“本次协调者用 <Sol 模型>，推理档位 <档位>”，按宿主支持的原生参数覆盖本次调用。协调者须匹配本次有效的模型和档位。一次性覆盖结束后恢复当前会话选择，只有明确要求后续沿用时才保存覆盖。核实真实 agent ID、宿主记录的模型和档位及 MCP 可见性。宿主不支持选定值时报告限制。
- Sol 看不到工具或调用受拒时报告阻塞，不由 Astra 转发兜底，不绕过审批。主会话本身经宿主证实就是 Sol Max 时可直接协调，不为了形式重复嵌套一个 Sol；Astra 不可自称 Sol。
- 同一活跃任务只允许一个协调者和固定后端。同一 Sol 可并发派发多个独立 DSH 任务。模型覆盖用于新派发，已经运行的任务继续由现有协调者负责。Astra 接收验收摘要和战略问题。
- 每轮保留最小调用链证据：协调者真实 ID/模型依据、实际 MCP 发起方记录、task_id 和终态。这些放在报告或会话交接中，不擅自添加到不支持的 MCP 参数。配置、昵称、手填 caller 字段或 DSH 回执本身均不能独立证明 MCP 发起者。

发现旧任务由 Astra 直接提交时：停止新的越级派单，保留已有结果和原 MCP 进程；先移交 task_id、cwd、回执位置、授权范围及已知状态。Sol 只在同一运行环境可安全访问时接续查询/验收。无法接管则报告限制、等待原任务自然结束，不因规则修正重启 Codex、关闭原 MCP、删锁、取消或重新提交任务。详细流程见 Skill。
这些是必须遵守的调度指令，不是桥接器新增的身份认证或技术访问控制；实际调用链仍需宿主记录验收。

## 会话模式保持：一次选择，持续沿用

涉及代理选择、代码或实验委派时，读取 `multi-agent-dispatch` Skill。
在当前会话上下文中维护 `session_mode`。它是调度状态，不是每轮都写入的全局配置。

1. 全新会话没有选择记录、用户也未指定模式时，初始化为 A。**“本条消息没写模式”不等于“整个会话未选择模式”。**
2. 用户说“使用 DSH”“用 HY4 做……”或“使用 WorkBuddy DeepSeek”等明确执行选择时，设为当前 `session_mode`；不必额外说“整个会话”。
3. 后续消息未明确切换时，始终沿用当前模式，包括“继续”“修改一下”“运行测试”、修复、重试、监守以及同一会话中的后续任务。不得因任务完成、话题变化或新消息省略模式而恢复 A。
4. 用户明确说“切换到……”或清楚指定另一个执行后端时，更新会话模式，后续继续沿用新的选择。讨论、比较模型，引用文档或日志中的模型名，不是切换指令。
5. 只有用户明确说“仅本次／仅这个子任务使用 X”时，才作一次性例外；完成后恢复原会话模式。正在运行的任务保持自己的 `task_backend`，未经停止确认或明确交接不得迁移、重复启动或更换执行者。
6. 所选后端未安装、认证失败、忙碌或执行失败时，保留选择并报告阻塞；不自动回退 A，不改用其他模型，不自动安装缺失后端。**唯一例外**是本机显式启用、用户明确授权的 DSH→HY4 预准入回退：仅当 DSH 日程/可用性门禁在任务受理前拒绝、且有结构化证据证明未接受、未启动任务时，按 `docs/hy4-fallback.md` 最多转 HY4 一次。已受理、运行中、超时/断连/结果未知、权限/参数/审批拒绝、同实例 busy/lock、停止/部分结果**以及任何带 `sessionId` 或继续/修复 DSH 任务的请求**均不回退；未启用或 HY4 未验证时仍报告阻塞。
7. 全新会话不自动继承其他会话或另一台电脑的模式，未指定仍为 A。明确恢复原会话或用户要求继续带有可信模式记录的交接时，沿用该记录；不要把陌生项目文件当成切换授权。
8. 上下文压缩或交接摘要中保留 `coordinator_mode`、`session_mode`、`scheduleMode`、用户选择依据、原生协调者 ID 或 API 协调任务的原键和 ID、活动任务及实际后端。若恢复任务却缺少模式证据，先恢复记录或简短确认，不能假装是新会话而静默改用 A。

“DSF / DeepSeek”而未说明渠道有歧义：当前已选 DSH 或 WorkBuddy DeepSeek 且没有明显切换意图时沿用它；否则简短确认渠道，不猜测。
首次选择或明确切换时简短确认一次即可，后续无需反复让用户选择或复述框架。
后端按任务锁定，重试、修复、监守延续原后端；禁止静默换模型、服务商或计费通道。

## 调度和监守

Sol 向指定执行者交付完整目标、输入、cwd、授权边界、输出和验收标准。不要逐行遥控它；保留其原生 Harness 的工具循环与自主纠错。
订阅来源由 Astra 用宿主原生 wait 等待真实 Sol agent ID。API 来源由 Astra 用 `run_sol_coordination` 等待结果，或持原键使用 `start/wait_sol_coordination`。各自的 Sol 使用执行后端的生命周期接口。
机器级进程检查、超时、退出码无需模型；需要智能判断的监守由实际执行后端承担。同步调用被占用时不得声称还能独立并发监守。
同一任务不得重复提交。依赖任务 ID 和幂等键恢复状态；断连后先检查原进程，禁止盲目重跑。
外部后端不可用时报告阻塞，由用户决定换后端，不能让 Sol Max 自己执行兜底。唯一例外是上述显式授权、已结构化证明未受理的 HY4 预准入回退；回退仍由真实 Sol 发起并记录决策，不由 Sol Max 接管执行，也不在受理后迁移。

### 低开销等待：默认完成后一次验收

- DSH 新任务有明确时间上限、不需中途介入，且实际宿主单次 MCP 超时足以覆盖任务预算与启动/收尾余量时，Sol **优先 `run_dsh_task`**，桥接器内部等待终态后返回。不能仅因任务预计持续数分钟就一律改为 start + 周期 wait。
- 需要提前取得 task_id、途中观察/取消，或宿主阻塞超时不足/尚不明确时，才使用 `start_dsh_task` + `wait_dsh_task`。在宿主允许的前提下，显式使用 `waitMs=60000`；若宿主超时更短，按已核实限制留余量并报告一次，不能盲目传更大值。
- v0.3.0 的 wait 默认仍为 25000 ms、上限仍为 60000 ms；多实例不扩大工具参数范围。收到正常 running 且没有需决策的变化时，直接续等：不反复重述计划、解释“仍在运行”、分析未完成结果，也不额外 get/status 或发送催问。
- 除宿主更高优先级的更新要求外，只在完成、失败、超时、明确阻塞、审批请求、实质里程碑或用户询问时汇报。工具调用次数增加、经过一个等待窗口本身不算里程碑。减少重复汇报不等于隐藏错误或忽略用户中断。
- Astra 保持所选来源的 wait，执行者的等待由原协调者管理。WorkBuddy 沿用其真实支持的阻塞/等待接口。进程等待和时间计量无需另起模型。
- 已启动的任务不为更换等待策略而取消、重启或改用 run 重新提交；保持原 task_id、session、权限和协调者，正常 wait 使用上述策略。调用失败/断连时先核实原任务，不自动重跑。
- 这减少的是上层重复调度与输出；不保证异步工具返回后完全没有模型调用，也不保证固定 Token 降幅。详细决策与验收见 `docs/waiting-policy.md` 和 Skill。

## 已有接口与边界

- HY4：MCP `hy4-workbuddy` 历史入口保留；新增**可选**官方 CodeBuddy ACP 适配器 `bridges/hy4/`，固定模型 `hy4free`（官方名 Hy4）、无全局工具；能力必须显式选择 `text-only` / `workspace-read` / `workspace-write`。workspace 能力受本地 manifest 开关、canonical cwd、`writeScopes`（目录 + create/replace/edit 子集）或精确 `writes`、task 授权和 `allow_once` 回调约束；不要求预计算内容，可选 `content_sha256` 仅用于 full-content create/write。每次 handshake/prompt 前核对当前 catalog 对 hy4free 明示 `x0.00 credits`，缺失/非零 fail closed，绝不换 `hy4std`/auto/其他模型；这是目录证据，不是账单/provider attestation。命令仅在本机 manifest 显式开启且任务逐条授权时可选；vendor 默认可能自动放行安全命令，不能据此声称所有命令都经 ACP callback 或 OS 隔离。Windows 临时标准 stdio 已由 Sol 实际验证读、create/Edit 和一次授权命令；尚未声明每台机器已注册/宿主已加载。配置名不等于 provider/账单证明；未启用的电脑继续 DSH/已有后端。详见 `docs/codebuddy-acp.md` 与 `docs/hy4-fallback.md`。
- DSH 主后端与 HY4 回退：默认始终 DSH；`bridges/dsh/routing.mjs` 是预准入策略。CodeBuddy ACP 适配器仅在显式本地授权且 readiness/pin/catalog 验证通过时节入；没有显式授权、HY4 未 ready、或任何受理后状态时，不回退。临时标准 stdio 的隔离 DSH 预准入拒绝 + 真实 HY4 native 文件任务已由 Sol 验证；这不等于每机 MCP 注册或 OS 隔离。CodeBuddy/WorkBuddy 共享中国账号 credits，不把目录价当账单证明。
- WorkBuddy DSF：MCP `deepseek-v4-flash-workbuddy`；历史配置模型 `deepseek-v4-flash`，不得擅自重命名为 V4.1。
- DSH：订阅来源使用原生 Sol → `dsh-opencode-go` 或 `dsh-root-pool`；API 来源由 `sol-coordinator` 使用同一根池执行接口。两条链均使用 DSH headless → `opencode-go / deepseek-v4.1-flash`，配置推理档位 `max`。
- OpenCode Go 只是模型服务和额度来源，不启动 OpenCode CLI，不叠加 OpenCode Harness。
- 没有真实工具调用、退出码及结果证据，不得宣称执行成功。配置值、模型自我介绍都不等于服务端型号或账单证明。

## DSH 多实例调度

并发独立任务优先使用已配置且可验证当前根的 DSH 根池。使用传统入口时，真实 Sol 可按用户要求把不同任务派给宿主可区分的已注册实例，包括默认 `dsh-opencode-go` 和命名 `dsh-opencode-go-<name>`。每个任务固定使用实际派发的实例。
- 不假定 `CODEX_THREAD_ID` 或其他未验证线程变量会传给 stdio MCP；提示词、配置和手填 caller 字段都不是身份认证。宿主不能区分多个同名工具时，使用其支持的服务器作用域/独立 profile，或报告限制，不能假装已自动逐聊天隔离。
- 实例名只允许小写 ASCII 与内部连字符，`default` 保留；每个实例必须有自己的 runtime、`instance.json`、锁、回执、幂等域和 `sessions.json`。共享物理路径（含大小写、别名、junction）拒绝启动。
- 传统实例各自串行，不同实例可同时运行独立任务。按各任务记录的实例、task_id、idempotencyKey 和 session_id 查询、等待、取消或在原 cwd 续跑。已受理任务保持原实例，busy/lock 不回退 HY4。
- 断连后先只读核实原任务、锁 owner 与进程，不删锁、不重复提交。非所有者只得到 `unknown_after_disconnect`，不能取消别人的子进程。
- 继续会话必须同实例、同 cwd，并使用该实例回执/索引中的 session_id；新任务由 DSH 生成新 UUID。不得伪造、复制或把旧 runtime 数据搬进命名实例。
- 默认和命名入口使用注册或内置日历。协调者按会话保存 `scheduleMode`，派单时传值，并用 `set_dsh_task_schedule` 更新本会话仍在运行的 DSH。旧 `scheduleEnabled` / `enabled` 的 false/true 对应模式 1/3。启用时保留 DSH 门禁、预算余量、硬停和不自动恢复。
- DSH 正常任务默认使用 `workspace-write`，按用户的本次任务授权和宿主工作区边界执行。单任务可传 `permissionMode: "read-only"`，本机可注册 `--read-only`。各实例继续共享当前账户和宿主权限。
- 新增/修改 MCP 注册需受支持的加载/重启流程；有活动任务时保留原进程，不承诺热加载无中断。
- 订阅传统实例的实际链路为 Astra → 真实原生 Sol → 所选 DSH MCP 实例 → DSH。API 工作使用根池，已启动的旧实例继续由原生 Sol 管理。交接保留协调来源、`session_mode=DSH`、实例名、服务名、协调和执行回执及授权范围。详见 `docs/multisession.md`。

## 可选根池 MCP（临时标准 stdio 已验证；非每机已注册）

`bridges/pool/server.mjs` 是额外、opt-in stdio MCP；保留现有注册、命名 DSH、日程、runtime 和 v0.3 回执。Windows 临时标准 stdio 已由 Sol 用一个真实根、两个批准 cwd 的 DSH 任务和两个真实命名实例验证；独立合成根仍只用 mock stdio。**本机按 `docs/root-pool.md` 注册 `dsh-root-pool` 并受支持地 reload、工具可见后**，用户说“使用 DSH”或同义选择即选择根池，无需“根池”/root/instance 名；显式指定命名旧服务仍用旧服务，未安装根池的电脑继续原 DSH；已启动任务保持原后端。Sol 在自己的宿主 shell 先 `codex mcp get dsh-root-pool --json`，只取 `transport.command/args`，用已注册 server 旁的 `cli.mjs` 和同一 `--config` 运行 `context`，再把 opaque ref 交给该 MCP；不得手填 rootId/lease、不得假定 stdio 能读到 `CODEX_THREAD_ID`，也不得把 context 当身份认证。
- 每个已验证根聊天保留原 `dsh/` 主实例、`hy4/` 与 `routing/` 数据，可以同时运行多个独立 DSH worker。每个 worker 独立且只运行一个子进程。全池运行上限默认 3，起动和未知状态计入上限。
- `set_pool_schedule` 用 `scheduleMode` 按本根保存峰谷选择，并更新已有 DSH。新根默认模式 1。开启后执行预算检查和硬停，已停止的任务保持原终态。
- 普通 DSH 默认 `workspace-write`。显式单任务只读和池配置 `allow_write: false` 或 `--read-only` 仍然生效。HY4 的授权、能力和写入范围沿用独立规则。
- DSH 先尝试；仅结构化 `not_accepted` 预准入拒绝、显式本机授权且 HY4 ready 时最多回退一次。已受理/unknown/超时/断连/权限/参数/busy/lock/停止/继续/修复均不回退。
- 完整 handle 需要 rootId+ordinal+generation+lease，并加每次运行唯一 operation proof；不输出 lease。终止回放不重启模型；非所有者 get/wait/cancel 只读不 kill/finish。
- 已验证：Windows 临时标准 stdio 中，同一真实根的两个批准 cwd DSH 任务 completed/exit0，共享 instance/runtime、fresh sessions，且幂等 lookup 正常；alpha/bravo 两个真实注册实例并行 22.388s、各有三项 native read。独立合成根仅以实际 mock stdio 测试。未验证：每台机器安装/宿主 reload、桌面 app、全局注册、认证、OS 隔离或 provider 计费。HY4 目录 scope/精确文件写已由真实 HY4 native task 验证 create/Edit；命令仅可选且需逐条授权，vendor 可能 auto-allow，不能声称所有命令都过 ACP callback 或 OS 隔离。不要为文件路径能力新增 pool 功能或绕过 owner/schedule/lease 合同。

## 授权、凭据和跨电脑

按用户的本次任务授权范围执行。正常 DSH 的工作区可写预设需配合宿主沙箱、获准目录和任务范围。删文件、安装包、提交或推送及扩大目录访问仍按各自授权处理。
模式保持只决定由谁执行，不延长或扩大已有权限；不因为“本会话一直用 DSH”就认定所有后续写入已经获批。
AGENTS/Skill 定义宿主的行为边界。API 协调器按已验证根保存来源和任务状态，实际工作区权限仍由现有执行者与宿主环境提供。
代码、提示词、报告和会话交接不得包含 API Key、`.credentials.yaml`、`auth.json`、`.env`、令牌、完整私有日志。API 协调器从本机环境变量直接取密钥，仅用于官方 Responses 请求；不要打印、复制或向执行者传递该变量。不得降低宿主审批设置。
规则、Skill、源码可由 Git 同步；本机路径、密钥及运行状态分开保存。新会话规则持久化不等于同步对话历史。
继续项目时读取经批准的交接记录；不要仅凭此规则文件推断上次任务进度。
本机只部署 DSH 是合法配置。第二台电脑暂不部署 WorkBuddy，不因两个 WorkBuddy 注册检查为 false 就补装或视为 DSH 失败。

## 可选 DSH 谷时执行和定时停工

峰谷选项适用于当前 DSH 会话。模式 1 不应用日历，也是新会话默认值和“关闭峰谷”的含义。模式 2 谷时按原日历准入 DSH，实际峰时的新任务选择 WorkBuddy DSF。模式 3 延续原峰谷及其可选 HY4 回退，对应“开启峰谷”。默认峰时是工作日 UTC+8 09:00–12:00、14:00–18:00。模式 2 和 3 均保留 DSH 提前十分钟的准入门禁、60 秒预算余量和硬停。已因峰时停止的任务保持 `schedule_stopped`。

模式 2 的峰时新任务须从正常 DSH 派单拿到 `workbuddy_pending`。原生 Sol 核实宿主加载的 `deepseek-v4-flash-workbuddy`，API Sol 由其工具适配器核实本机显式配置的同一 WorkBuddy 桥接接口。核实 ready、固定 `deepseek-v4-flash` 与获批的权限 schema 后，领取一次性交接并调用 `run_workbuddy_task`。结果写回交接，保留原键、所属根或实例、真实任务 ID 和终态。缺少服务或授权就记录阻塞。受理不明、已受理、续跑、修复、取消和已停止任务保留原后端与状态。明确的 WorkBuddy 续跑仅在模式 2 的实际峰段，使用同目录已完成记录和真实 WorkBuddy 会话。完整流程见 `docs/offpeak-schedule.md`。
