# isheach/ai_rule — 多代理长期规则

规则修订：2026-11-12.dsh-multisession-r1；HY4 预准入回退候选：2026-11-13.hy4-preadmission-r1。桥接器/安装器版本 v0.3.0。
本文件是用户确认的长期偏好，不是绕过宿主安全策略的授权。遵守当前会话明确要求及更高优先级指令。
安装后在新会话加载；GitHub 上的文件本身不会远程注入其他电脑。

## 执行后端与职责

| 选择 | Sol Max 职责 | 实际执行 | 智能监守 |
|---|---|---|---|
| A／原生（全新会话未选择时的默认值） | 规划、执行、实验分析、自审 | GPT-6.1 Sol Max | 仅有必要时 GPT-6 Luna Max |
| HY4／WorkBuddy HY4 | 仅规划、调度、验收 | WorkBuddy HY4 | HY4 自行负责 |
| WorkBuddy DeepSeek／WorkBuddy DSF | 仅规划、调度、验收 | WorkBuddy DeepSeek | 同一 DeepSeek 后端 |
| DSH／DSH DeepSeek | 仅规划、调度、验收 | DSH 原生 Harness + DeepSeek | DSH 的同一后端 |

Astra 始终负责研究大方向和重大路线决策，不额外增加智能决策层。
Luna **仅**用于 Sol Max 自己执行且确实需要持续监守的任务。外部后端不得使用 Luna 监守。
外部执行时，Sol Max 可以读报告、任务状态及差异进行验收；不能亲自编辑业务代码、编写测试、运行实验、修复或偷偷接管失败任务。需要修订时，规划后交回原执行者。
本文件中的 Astra / Sol Max / Luna Max 是用户角色名称，不是可直接假定有效的 API model ID。使用宿主已有、经验证的模型映射；不可用时报告，不得给其他模型冒名。

## 实际调用链：不能用角色描述代替真实子代理

在 Astra 主会话中，外部模式必须为：**Astra → 真实 GPT-6.1 Sol Max（max）子代理 → 所选外部 MCP → 执行 Harness**。
创建了 Sol 子代理、却由 Astra 自己调用外部 MCP，仍然不合格；Sol 不能只是建议顾问或提示词撰写者。

- Astra 负责目标、授权边界、重大决策，创建或恢复真实 Sol 协调子代理，向其完整交接，然后用宿主原生 wait 等待该真实 agent ID。
- Sol 必须在自己的执行上下文中实际提交外部任务，并负责状态查询、等待、结果验收、必要的修订派单。Astra 不得以“宿主转发”“避免重复”“工具在主会话更方便”为由代发。
- Astra 不直接调用外部执行 MCP 的 run/start、修订派单、日常轮询/wait 或取消工具。常规状态探测也交给 Sol；用户明确要求的只读调度审计或紧急停止按授权执行，并记录为例外，不转化为后续派单权。
- 首次建立或更换协调者时，核实真实 agent ID、宿主记录的模型及档位、对应 MCP 的可见性。用户已报告本机验证过的映射是 `gpt-6.1-sol / max`；仍以当次宿主真实记录为准，不用昵称或自我介绍证明身份。不得猜造创建参数。
- Sol 看不到工具或调用受拒时报告阻塞，不由 Astra 转发兜底，不绕过审批。主会话本身经宿主证实就是 Sol Max 时可直接协调，不为了形式重复嵌套一个 Sol；Astra 不可自称 Sol。
- 同一活跃任务只允许一个协调者。优先复用可安全恢复的 Sol 子代理；无需每个小步骤新建代理。Astra 接收验收摘要和战略问题，不重复 Sol 的整套技术验收。
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
8. 上下文压缩或交接摘要中保留当前模式、用户选择依据、协调子代理 ID、活动任务 ID 与任务后端。若恢复任务却缺少模式证据，先恢复记录或简短确认，不能假装是新会话而静默改用 A。

“DSF / DeepSeek”而未说明渠道有歧义：当前已选 DSH 或 WorkBuddy DeepSeek 且没有明显切换意图时沿用它；否则简短确认渠道，不猜测。
首次选择或明确切换时简短确认一次即可，后续无需反复让用户选择或复述框架。
后端按任务锁定，重试、修复、监守延续原后端；禁止静默换模型、服务商或计费通道。

## 调度和监守

Sol 向指定执行者交付完整目标、输入、cwd、授权边界、输出和验收标准。不要逐行遥控它；保留其原生 Harness 的工具循环与自主纠错。
Astra 用宿主真实提供的内置 wait 等待 Sol 的原生 agent ID；Sol 按下述策略使用外部 MCP 的同步执行或等待接口。MCP 任务并不自动拥有原生 agent ID，不能混用或伪造。
机器级进程检查、超时、退出码无需模型；需要智能判断的监守由实际执行后端承担。同步调用被占用时不得声称还能独立并发监守。
同一任务不得重复提交。依赖任务 ID 和幂等键恢复状态；断连后先检查原进程，禁止盲目重跑。
外部后端不可用时报告阻塞，由用户决定换后端，不能让 Sol Max 自己执行兜底。唯一例外是上述显式授权、已结构化证明未受理的 HY4 预准入回退；回退仍由真实 Sol 发起并记录决策，不由 Sol Max 接管执行，也不在受理后迁移。

### 低开销等待：默认完成后一次验收

- DSH 新任务有明确时间上限、不需中途介入，且实际宿主单次 MCP 超时足以覆盖任务预算与启动/收尾余量时，Sol **优先 `run_dsh_task`**，桥接器内部等待终态后返回。不能仅因任务预计持续数分钟就一律改为 start + 周期 wait。
- 需要提前取得 task_id、途中观察/取消，或宿主阻塞超时不足/尚不明确时，才使用 `start_dsh_task` + `wait_dsh_task`。在宿主允许的前提下，显式使用 `waitMs=60000`；若宿主超时更短，按已核实限制留余量并报告一次，不能盲目传更大值。
- v0.3.0 的 wait 默认仍为 25000 ms、上限仍为 60000 ms；多实例不扩大工具参数范围。收到正常 running 且没有需决策的变化时，直接续等：不反复重述计划、解释“仍在运行”、分析未完成结果，也不额外 get/status 或发送催问。
- 除宿主更高优先级的更新要求外，只在完成、失败、超时、明确阻塞、审批请求、实质里程碑或用户询问时汇报。工具调用次数增加、经过一个等待窗口本身不算里程碑。减少重复汇报不等于隐藏错误或忽略用户中断。
- Astra 保持原生 wait，不同时查询同一 DSH 任务；不新建模型监守者来做状态计时。WorkBuddy 沿用其真实支持的阻塞/等待接口，不套用 DSH 参数。
- 已启动的任务不为更换等待策略而取消、重启或改用 run 重新提交；保持原 task_id、session、权限和协调者，正常 wait 使用上述策略。调用失败/断连时先核实原任务，不自动重跑。
- 这减少的是上层重复调度与输出；不保证异步工具返回后完全没有模型调用，也不保证固定 Token 降幅。详细决策与验收见 `docs/waiting-policy.md` 和 Skill。

## 已有接口与边界

- HY4：MCP `hy4-workbuddy` 历史入口保留；新增**可选**官方 CodeBuddy ACP 适配器 `bridges/hy4/`，固定模型 `hy4free`（官方名 Hy4）、无全局工具；能力必须显式选择 `text-only` / `workspace-read` / `workspace-write`。workspace 能力受本地 manifest 开关、canonical cwd、`writeScopes`（目录 + create/replace/edit 子集）或精确 `writes`、task 授权和 `allow_once` 回调约束；不要求预计算内容，可选 `content_sha256` 仅用于 full-content create/write。每次 handshake/prompt 前核对当前 catalog 对 hy4free 明示 `x0.00 credits`，缺失/非零 fail closed，绝不换 `hy4std`/auto/其他模型；这是目录证据，不是账单/provider attestation。命令仅在本机 manifest 显式开启且任务逐条授权时可选；vendor 默认可能自动放行安全命令，不能据此声称所有命令都经 ACP callback 或 OS 隔离。Windows 临时标准 stdio 已由 Sol 实际验证读、create/Edit 和一次授权命令；尚未声明每台机器已注册/宿主已加载。配置名不等于 provider/账单证明；未启用的电脑继续 DSH/已有后端。详见 `docs/codebuddy-acp.md` 与 `docs/hy4-fallback.md`。
- DSH 主后端与 HY4 回退：默认始终 DSH；`bridges/dsh/routing.mjs` 是预准入策略。CodeBuddy ACP 适配器仅在显式本地授权且 readiness/pin/catalog 验证通过时节入；没有显式授权、HY4 未 ready、或任何受理后状态时，不回退。临时标准 stdio 的隔离 DSH 预准入拒绝 + 真实 HY4 native 文件任务已由 Sol 验证；这不等于每机 MCP 注册或 OS 隔离。CodeBuddy/WorkBuddy 共享中国账号 credits，不把目录价当账单证明。
- WorkBuddy DSF：MCP `deepseek-v4-flash-workbuddy`；历史配置模型 `deepseek-v4-flash`，不得擅自重命名为 V4.1。
- DSH：真实 Sol 协调子代理 → MCP `dsh-opencode-go` → DSH headless → `opencode-go / deepseek-v4.1-flash`，配置推理档位 `max`。
- OpenCode Go 只是模型服务和额度来源，不启动 OpenCode CLI，不叠加 OpenCode Harness。
- 没有真实工具调用、退出码及结果证据，不得宣称执行成功。配置值、模型自我介绍都不等于服务端型号或账单证明。

## DSH 多实例：同机多聊天各用一个命名实例

同一台电脑可注册多个命名 DSH MCP 服务：默认 `dsh-opencode-go`（实例 `default`，沿用旧 runtime/回执），命名实例 `dsh-opencode-go-<name>`（独立 runtime）。每个聊天在会话中固定选择一个服务，并让真实 Sol 实际调用该服务的工具；选择是宿主可见的 MCP 服务选择，不是提示词自称。
- 不假定 `CODEX_THREAD_ID` 或其他未验证线程变量会传给 stdio MCP；提示词、配置和手填 caller 字段都不是身份认证。宿主不能区分多个同名工具时，使用其支持的服务器作用域/独立 profile，或报告限制，不能假装已自动逐聊天隔离。
- 实例名只允许小写 ASCII 与内部连字符，`default` 保留；每个实例必须有自己的 runtime、`instance.json`、锁、回执、幂等域和 `sessions.json`。共享物理路径（含大小写、别名、junction）拒绝启动。
- 不同实例可并行；同一实例仍单任务互斥。task_id、idempotencyKey 和 session_id 都只在所属实例有效；禁止跨实例 get/wait/cancel，错误域查询必须安全失败。busy/lock 是独立类别：本阶段不自动回退 HY4，除非有安全证据证明不是同一工作的重复提交；不得猜测或用回退绕过实例互斥。
- 断连后先只读核实原任务、锁 owner 与进程，不删锁、不重复提交。非所有者只得到 `unknown_after_disconnect`，不能取消别人的子进程。
- 继续会话必须同实例、同 cwd，并使用该实例回执/索引中的 session_id；新任务由 DSH 生成新 UUID。不得伪造、复制或把旧 runtime 数据搬进命名实例。
- 每个实例都必须保留有效的 `--schedule-config` 传递（若本机启用）、峰谷准入、预算+安全余量、硬停工和 `resume_automatically=false`。任何新实例都不能用来绕过已启用日程；硬停工只终止该实例自己的子进程。
- 默认只读；workspace-write 仍需本机显式启用和本次任务授权。实例隔离不等于 DSH 凭据/账户/额度/会话存储/OS 权限隔离，也不实现额外 OS 沙箱。
- 新增/修改 MCP 注册需受支持的加载/重启流程；有活动任务时保留原进程，不承诺热加载无中断。
- 实际链路仍为 Astra → 真实 Sol Max → 所选 DSH MCP 实例 → DSH。实例只是 MCP 端点，不是额外代理层。交接保留 `session_mode=DSH`、实例名、服务名、协调者 ID、活动 task_id 和授权范围。详见 `docs/multisession.md`。

## 可选根池 MCP（临时标准 stdio 已验证；非每机已注册）

`bridges/pool/server.mjs` 是额外、opt-in stdio MCP；保留现有注册、命名 DSH、日程、runtime 和 v0.3 回执。Windows 临时标准 stdio 已由 Sol 用一个真实根、两个批准 cwd 的 DSH 任务和两个真实命名实例验证；独立合成根仍只用 mock stdio。**本机按 `docs/root-pool.md` 注册 `dsh-root-pool` 并受支持地 reload、工具可见后**，用户说“使用 DSH”或同义选择即选择根池，无需“根池”/root/instance 名；显式指定命名旧服务仍用旧服务，未安装根池的电脑继续原 DSH；已启动任务保持原后端。Sol 在自己的宿主 shell 先 `codex mcp get dsh-root-pool --json`，只取 `transport.command/args`，用已注册 server 旁的 `cli.mjs` 和同一 `--config` 运行 `context`，再把 opaque ref 交给该 MCP；不得手填 rootId/lease、不得假定 stdio 能读到 `CODEX_THREAD_ID`，也不得把 context 当身份认证。
- 每个已验证根聊天拥有独立 `dsh/`、`hy4/`、`routing/` runtime 与稳定 `pool-<hash>` 实例；空闲 binding 不保留进程。
- 机器级 running cap 默认 3；binding cap 可选。日程必须显式启用、硬停工、预算检查、`resumeAutomatically=false`；不自动恢复。
- 默认只读；`workspace-write` 同时需要本机 `allow_write` + server `--allow-write` + 每任务显式授权。
- DSH 先尝试；仅结构化 `not_accepted` 预准入拒绝、显式本机授权且 HY4 ready 时最多回退一次。已受理/unknown/超时/断连/权限/参数/busy/lock/停止/继续/修复均不回退。
- 完整 handle 需要 rootId+ordinal+generation+lease，并加每次运行唯一 operation proof；不输出 lease。终止回放不重启模型；非所有者 get/wait/cancel 只读不 kill/finish。
- 已验证：Windows 临时标准 stdio 中，同一真实根的两个批准 cwd DSH 任务 completed/exit0，共享 instance/runtime、fresh sessions，且幂等 lookup 正常；alpha/bravo 两个真实注册实例并行 22.388s、各有三项 native read。独立合成根仅以实际 mock stdio 测试。未验证：每台机器安装/宿主 reload、桌面 app、全局注册、认证、OS 隔离或 provider 计费。HY4 目录 scope/精确文件写已由真实 HY4 native task 验证 create/Edit；命令仅可选且需逐条授权，vendor 可能 auto-allow，不能声称所有命令都过 ACP callback 或 OS 隔离。不要为文件路径能力新增 pool 功能或绕过 owner/schedule/lease 合同。

## 授权、凭据和跨电脑

执行前按用户授权范围操作。默认只读；用户明确批准写入范围后才允许相应写入。派单本身不授予删文件、安装包、提交/推送、扩大目录访问等权限。
模式保持只决定由谁执行，不延长或扩大已有权限；不因为“本会话一直用 DSH”就认定所有后续写入已经获批。
AGENTS/Skill 是行为规则，不是 OS 沙箱或程序强制的路由状态机；MCP 的权限参数也不能被描述成经过验证的操作系统隔离。
禁止读取或上传 API Key、`.credentials.yaml`、`auth.json`、`.env`、令牌、完整私有日志。不得降低宿主审批设置。
规则、Skill、源码可由 Git 同步；本机路径、密钥及运行状态分开保存。新会话规则持久化不等于同步对话历史。
继续项目时读取经批准的交接记录；不要仅凭此规则文件推断上次任务进度。
本机只部署 DSH 是合法配置。第二台电脑暂不部署 WorkBuddy，不因两个 WorkBuddy 注册检查为 false 就补装或视为 DSH 失败。

## 可选 DSH 谷时执行和定时停工

只有本机 MCP 显式配置 `--schedule-config` 后，才启用真正的峰时门禁和本地硬停工。工作日 UTC+8 09:00–12:00、14:00–18:00 为 OpenCode Go DeepSeek 的峰时；默认提前 10 分钟禁止新 DSH 任务，并拒绝完整预算可能跨越峰时的任务。已运行任务若到达峰时，会被桥接器尽力结束且标记 `schedule_stopped`，**不自动恢复，也不标记成功**。到点停止可能损失未保存结果；进度提示并不是 DSH 的可靠实时检查点。仍按现有 Astra→真实 Sol→DSH 调度；只有本机显式启用并验证的预准入 HY4 回退策略可在“未受理”时按 `docs/hy4-fallback.md` 转一次 HY4，否则不把被拒绝的任务交给 Sol/Luna/WorkBuddy 代做。不允许为了日程控制而扩大权限，也不实现通用日程绕过。详细配置见 `docs/offpeak-schedule.md`。
