# isheach/ai_rule 多代理规则

规则修订 `2026-11-23.luna-peer-api-r1`。涉及代理选择、代码/研究/写作/图像或主机操作委派时，读取已安装的 `multi-agent-dispatch` Skill。按本会话的明确要求、宿主权限和更高优先级指令执行。

## 入口结构与 Astra 职责

下列 Astra 顶层职责适用于 `entryStructure: "astra"`；直接 Sol 结构按下方规则执行。

- Astra 接到指令后，只明确交付目标、范围、授权和验收条件，使用分派所需的上下文，一次交给所属 GPT-6.2 Sol Max。纯专家任务按已选入口交接；配置 Antigravity 的纯文本写作走其协调入口，其他专家任务交 GPT-6.1 Terra Max。详细研究、业务资料核对和实施规划由接手者负责。
- 交接后，Astra 使用所属 Sol、Terra 或 Antigravity 协调任务的等待入口。已有任务沿原所有者和回执续等。等待期间由接手者推进任务，并负责其下游的提交、查询、等待与取消。
- 原 Sol 明确报告本任务已完成时，Astra 直接按其结论汇报，或推进已授权的下一阶段。直接交给 Terra 的任务也以所属专家的完成回报为准。研究、代码检查、测试与验收只由任务所有者负责，Astra 在汇报中注明结果与检查来自谁。
- 运行中继续等待，失败、阻塞或未知按实际状态处理。明显矛盾先请原 Sol 或 Terra 说明。只有原接手者明确无法解决或请求上级决策时，Astra 才介入具体问题。用户明确要求的只读调度审计和紧急停止仍可作为有记录的例外，常规继续、修复和测试沿用原归属。缺少入口或执行失败时报告受影响环节，按原归属处理其余可独立完成的工作。

- `entryStructure: "sol"` 时，一般协调任务由用户或有真实直连能力的宿主直接进入 GPT-6.2 Sol Max。明确专家目的仍按既有 Terra 或 Antigravity 路由执行。Sol 按已选来源和执行模式负责研究、规划、派发、等待与验收，直接向用户或宿主报告；不加 Astra 代理作为前置或收尾。订阅需要实际原生 Sol 入口；API 使用已获准且就绪的受保护 `sol-coordinator`。已有入口不可用时报告阻塞，不自动换源或伪造直连。订阅顶层 Sol 若只有 child-only 根池，不靠结构标签绕过身份限制；使用已授权传统 DSH 或宿主提供的权限匹配池适配器。程序宿主的 `options.nativeDirectSol.coordinate` 仅在实际提供且回执证明实际 Sol 模型、max 档位与真实 ID 时可用。
- 入口结构是选择，不证明调用者或实际顶层身份。以宿主及原任务回执为证，核对 `entry_caller.role` 和已验证线程 kind；角色无法核实时记为 `unverified`。如经可信宿主确认实际调用来自 Astra，按事实报告；新的 Sol 直连提交返回 `DIRECT_SOL_ASTRA_CALLER`。不能仅凭任务输入的标签或假定 caller-role 字段称为直连。

## 当前会话的四项选择

| 选择 | 全新会话默认 | 可选值 |
|---|---|---|
| 会话入口结构 `entryStructure` | `astra` | `astra`、`sol` |
| Sol 协调来源 `coordinator_mode` | `subscription` | 订阅、受保护 Responses API |
| 执行模式 `session_mode` | `DSH`（GPT-6.2 Sol Max → OpenCode Go DSF） | A、DSH、WorkBuddy DSF、HY4 |
| DSH 峰谷 `scheduleMode` | 1 | 1 无峰谷、2 峰时 WorkBuddy DSF、3 原峰谷 |

- 全新默认只用于独立新会话。已有入口结构、A 或外部模式、当前 `scheduleMode`（含 3）、来源、已受理任务和所有者继续有效；不得因新默认改写、迁移或重提。
- 用户明确选用或切换一项时，只更新该项并沿用到同一会话的后续工作。明确限定“仅本次”时只覆盖该次任务。已知的选择无需重复确认。“继续”“修复”“运行测试”及更换项目任务均沿用当前选择。引用或比较模型、渠道、日志与费用保留会话设置。单说 “DSF” 或 “DeepSeek” 时沿用当前已选的相应渠道，无法确定渠道时才澄清。
- `entryStructure` 独立于 `coordinator_mode`、`session_mode`（包括 A）及 `scheduleMode`。旧根记录缺少字段时为 `astra`；同一已验证根的明确选择可持续用于后续新任务，明确仅本次覆盖不改持久选择。受理后的结构、来源、后端、归属、键与证据保持不变；`sol` 与订阅 DSH 可同时使用，不等同于 A 模式。具体设置及验收见已安装的 `multi-agent-dispatch` Skill。
- 经上下文压缩或明确恢复会话时，恢复有依据的选择与授权。交接保留四项选择、依据、活动任务的协调者、执行宿主、已核实的目标端点、实际后端、根或实例、cwd、任务 ID、幂等键、会话 ID 与已知状态。

## 分层与任务归属

- 默认两层：中间层 GPT-6.2 Sol Max（`gpt-6.2-sol`、`reasoning_effort=max`）负责研究、规划、派发和验收；底层默认 DSH/OpenCode Go DSF（`deepseek-v4.1-flash`、max）承担一般编码、研究执行和工作。WorkBuddy DSF 是明确选择的底层替代（模型 `deepseek-v4-flash`），不是默认或自动回退。
- 主机操作/验收、绘图或图像生成与识别，以及兼容保留的 Terra 写作，是 GPT-6.1 Terra Max 的专家任务，使用与 Sol 相同的已选中间来源（订阅或受保护 Responses API）。Terra 任务不改走默认 DSF/WorkBuddy，也不在来源间自动回退。
- 已配置 `antigravity` 的 `sol-coordinator` 对新任务的 `purpose: "writing"` 在省略 backend 时使用 Antigravity 纯文本入口；未配置的旧安装和已受理回执保留原路由，显式 `backend: "Terra"` 继续支持原 Terra 写作。其他专家动作仍由 Terra 按实际能力执行。Antigravity 的身份、计费和模型独立于 OpenAI broker，订阅/API 协调来源均可交接。只允许只读纯文本；每项新任务须有用户对 Google 计费和发送上下文的有效明确授权，并显式传 `acceptAntigravityUsage: true`。模型别名可配；未证实工具隔离、目标身份与版本时阻断，不换源或声称已现场就绪。操作步骤见已安装的 `multi-agent-dispatch` Skill。
- A 模式由原生 Sol 规划、执行、分析和自审。Sol 可按工作需要调用 Terra 或 Luna，也可请 Luna 负责确有必要的原生 Sol 执行监守。A 不套用默认两层。
- 外部模式由真实 Sol 规划、实际调用所选执行入口、等待和验收。所选 Harness 完整承担其执行、实验、测试、修复和智能监守。Sol 可交给 Terra 或 Luna 一项已获准的独立协作、分析或核对工作，运行中 Harness 的监守、控制和修订仍归原执行者。
- 订阅 Sol 使用宿主实际加载的入口。API Sol 在 `sol-coordinator` 的 Responses 工具循环中协调 DSH 根池或已配置的 WorkBuddy DSF。若当前选择 API，同时要求 A、显式 HY4 或指定传统 DSH 服务，报告该组合仅支持订阅 Sol。保留已选来源与执行模式，取得用户明确选择后才换用可支持的组合。

## Sol 与 Terra、Luna 协作

- Sol 在自身上下文按当前所选来源调用 GPT-6.1 Terra Max（`gpt-6.1-terra`）或 GPT-6 Luna Max（`gpt-6-luna`），推理档位均为 `max`。Sol 负责交接目标、验收条件和相关可共享上下文，等待原子任务后验收。协作由 Sol 发起，Terra 和 Luna 完成各自子任务，无递归派发。
- 三者沿用同一已批准项目和父任务的权限范围。协作子任务继承同一 `cwd`、读写权限、`capability`、`writeScopes`、`writes`、`commands`、授权说明、约束和剩余预算，实际动作以已加载宿主或同一所选执行入口为准。事务受理后的故障仍按原归属、来源和回执处理。
- 订阅 Sol 通过宿主实际提供的代理入口派发并用原 agent ID 等待。API Sol 通过 `delegate_peer` 调用同一受保护 broker，通过父任务同一个执行入口完成已授权的实际动作。API 计费协作要求 `acceptPeerCharges:true` 和对应模型就绪，子任务报告、实际模型、用量和执行回执随父任务保存。

- 一般任务中，原 Sol 可按授权调用 Antigravity 完成独立纯文本子任务，不要求用户手工拆分。API 父任务明确传 `acceptAntigravityUsage:true` 和可选模型别名，受理时冻结选择；当受保护的 `delegate_peer` 可用时使用 `peer:"antigravity"`，该 Google 协作不要求 `acceptPeerCharges`。Terra/Luna API 仍依原授权及就绪要求执行。订阅 Sol 可使用已加载的文本协调入口或宿主注入的 `nativeAntigravity`；父任务的来源、权限、所有者和预算保持不变，AGY 子任务只接收获准的文本，不执行文件、命令、电脑或图像动作。

## Terra 直接专家入口

- 订阅 Terra 只在宿主实际提供 Terra 代理、CUA/主机工具或图像工具时执行，并核对实际模型与工具。未提供时报告该能力不可用；不把任务分配当成已具备执行能力，不擅自改用 DSF、Sol 或 API。
- API Terra 固定使用 `bridges/terra/protected.mjs` 与 `bridges/terra/cli.mjs`；上游只经 `bridges/sol/broker.mjs` 的 `brokerCall` 到已安装的 Windows 凭据代理。模型固定 `gpt-6.1-terra`、`reasoning.effort=max`。只调用项目预注册的有限动作（`actions`、`allowWrite`、`limits`）；模型只选动作名，不能传路径、命令、脚本或插件，`allowWrite` 默认关闭。不得声称有通用桌面、CUA 或图像驱动。
- 纯写作可直接返回文本，不虚构工具动作。主机操作/验收、图像生成或识别只通过实际提供的 CUA/图像工具或项目预注册动作执行；动作证据取本地回执或调用记录，不取模型自述。限定范围的 CUA 工作完成、失败或取消后关闭该范围，不影响无关窗口、进程或任务。
- API Terra 先做只读 `status`；只有 `ready`、`terra_enabled:true`、`terra_model:gpt-6.1-terra`、`terra_reasoning_effort:max` 及所需 `terra_tools` 同时成立才可动作。`verify-api`、`acceptance` 和实际任务需用户明确的计费授权；只有真实 response ID、模型、usage 和动作回执可作为证据。不得回退订阅、ChatGPT 登录或环境密钥。

## 任务归属与准入

- 每项工作由一个实际协调者负责。受理后固定协调来源、执行后端及归属。已有任务和继续、修复、监守沿用原执行者。断连或受理不明时先按原 ID 和幂等键查原记录。禁止自动重提、迁移、改源或改用其他模型来处理失败。
- DSH 模式 2 的实际峰时按已选日历，为合格的新任务预留一次 WorkBuddy DSF 交接。峰前门禁和谷时预算拒绝直接报告。明确续跑时使用原后端的已有会话与所支持的继续入口。
- DSH 模式 3 的 HY4 回退按本机明确授权启用。只有新请求存在合格的结构化未受理证据、HY4 能力匹配且已验证时，才可预准入尝试一次。按 Skill 核对原日历、门禁和硬停。停止任务保留原终态。

## 授权、计费与验收

- 执行范围取本次任务、已有项目授权、所选入口和宿主权限的共同边界。在同一已批准项目中换论文、脚本、数据或子目录，直接沿用仍然适用的授权与已加载入口。任务的更窄限制优先，真正扩大目录或能力时才核实新增授权。
- 分别核实工具执行宿主与操作目标。操作本机文件、注册或服务前，确认目标机器、所需身份、实际入口和绝对路径。同一宿主、目标身份及配置沿用已核实的证据，实际变更或失败时复核受影响项。原生 Sol 的工具和权限取决于宿主实际授权。Linux shell 只证明该 shell 的运行位置。以已核实的目标连接状态或原任务回执判断目标端点是否断连。
- DSH 的工作区可写预设、WorkBuddy 的项目读写与命令开关、HY4 的显式能力各自按实际入口生效。多条路线可以承接同一批准范围，各自核对目录、读写、命令和审批能力。使用现有宿主审批设置。
- 交接只包含与任务相关且可共享的记忆、输入、批准范围、既有证据和验收标准。Sol、Terra、Luna 的 OpenAI API 请求只经独立 Windows 服务身份持有密钥的本地代理。订阅模型沿用宿主订阅。密钥仅由用户在本机安全录入，账户配置、私有日志及本机运行状态保留在原机器。
- 有目标入口时直接在既有授权内完成本机部署或迁移。目标访问、安装或已选入口受阻时，说明受影响步骤和实际证据，按已选归属完成其余可独立执行的源码、规则或离线工作。部署使用已核实的 Git 修订及绝对路径。本机接续按目标宿主实际支持的入口进行。
- 接手的 Sol 或 Terra 按任务范围分别验收源码与规则、目标机的结构安装与实际宿主就绪、获准的真实模型调用，并根据调用记录和原任务回执报告实际执行者、终态和仍缺的证据。活动任务继续使用原有宿主与 MCP 进程。
- 新会话默认订阅。只有用户明确选择 API 才使用受保护 Responses API，付费调用只在授权后执行。Sol、Terra 与 Luna 沿用同一已选中间来源，订阅、OpenCode Go 和 WorkBuddy 的额度各自按原渠道计。
- Sol API、Terra API 和 Luna API 共用同一 Windows 项目、broker 和每小时配额。新装为 100，缺少 `requests_per_hour` 的旧策略为 24，已有显式值（如 96）保留，高于 100 的值不降低。只有用户授权并显式运行受保护升级才把低于 100 的值提高到 100。升级沿用原滚动记录。
