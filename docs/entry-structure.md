# 会话入口结构

`entryStructure` 表示新任务由谁进入和协调，取 `astra` 或 `sol`。它与 Sol 来源 `coordinator_mode`、执行模式 `session_mode`（包括 A、DSH、WorkBuddy DSF、HY4）以及 DSH 的 `scheduleMode` 分开设置。改变其中一项不会自动修改其他项，也不会改变任务已有的授权和能力。

| 入口结构 | 正常路径 | 结果与依据 |
|---|---|---|
| `astra` | Astra 明确目标、范围、授权和验收后交给实际的 Sol；专门的 Terra 和已配置的 Antigravity 写作仍按原专家路由 | Astra 使用所属入口等待，按原 Sol 或专家的结果汇报；实现、测试和验收由原接手者负责 |
| `sol` | 一般协调任务由用户或具备实际能力的宿主直接进入 GPT-6.2 Sol Max，Sol 研究、规划、使用已选执行入口、等待和验收 | Sol 直接向用户或宿主返回结果；实际模型、执行入口和任务归属必须有宿主或回执证据 |

明确专家目的的 Terra 或 Antigravity 任务仍沿原专家路由；选择结构本身不能证明这些任务经过 Sol，实际执行者以回执为准。

旧根记录缺少该字段时默认为 `astra`。在同一经过验证的根会话中，明确设置的入口结构可持续用于之后的新任务；一次性覆盖只作用于该次任务，不改写根上的持久选择。已受理任务保留原入口结构、协调来源、后端、原所有者、ID、幂等键、会话及证据，继续、修复、等待和取消仍沿原入口。状态不明先按原回执查证，不能因选择变化自动重提或迁移。

`entryStructure: "sol"` 不等同于 `session_mode: "A"`。例如，直接 Sol 入口与订阅来源、DSH 底层可以同时成立；Sol 仍真实调用 DSH 并验收。A 模式是原生 Sol 自行执行和自审的执行模式。API 来源与 A、显式 HY4 或传统 DSH 服务的原有限制仍然有效。

## 读取和设置

先由当前实际宿主使用已注册的 `sol-coordinator` 和其辅助程序取得验证过的 `context_ref`。`context` 绑定原宿主、根及父链，过期时在同一宿主刷新；不要手填根、会话 ID、父链或 lease。具体获取方法见已安装的 `multi-agent-dispatch` Skill。

在已加载的 MCP 中：

- `get_sol_entry_structure({ context })` 读取该根的入口结构；`get_sol_coordinator_mode({ context })` 也并列报告入口结构及协调来源。返回的 `entry_structure` 和 `entry_structure_source` 区分当前选择及其依据，不证明实际调用者。
- 用户明确要求之后持续使用新结构时，调用 `set_sol_entry_structure({ context, entryStructure: "sol" })`；要恢复 Astra 入口则传 `"astra"`。设置只影响同一已验证根之后的新任务。
- 仅本次指定时，在 `start_sol_coordination`、`run_sol_coordination` 或只读 `resolve_layer_dispatch` 的参数中传 `entryStructure`，不调用持久设置工具。若省略字段，采用已验证根上持久的选择；旧记录缺字段则采用 `astra`。

也可在保存自身 rollout 的实际 Codex 宿主，使用已注册协调器的真实配置绝对路径操作同一根：

```sh
node bridges/sol/cli.mjs entry-structure-status --config <ABS>
node bridges/sol/cli.mjs set-entry-structure --config <ABS> sol
```

第二条命令持久设置为 `sol`，要恢复 Astra 则把末尾改为 `astra`。这两个命令使用实际宿主的 `CODEX_THREAD_ID` 核验已有 rollout 根，不调用模型；普通 shell 若没有可核验的该宿主线程，不能用手填 ID 代替，也不能据此声称已切换成功。只需本次覆盖时不执行持久设置。

只读路由解析示例：

```json
{
  "context": "<当前宿主提供的 context_ref>",
  "entryStructure": "sol",
  "purpose": "general"
}
```

上面的对象用于 `resolve_layer_dispatch`，不会启动模型。也可在已核实的源码工作区使用只读 CLI 解析，以下命令不派发任务：

```sh
node bridges/dispatch/cli.mjs resolve --entry-structure sol --source subscription --purpose general
```

解析结果只说明选定路线，不能证明本机提供真实顶层 Sol、模型调用已经发生或工具就绪。

## 直接 Sol：订阅和 API

**订阅来源**需要宿主实际提供用户可直接进入的 `gpt-6.2-sol`、`reasoning_effort=max` 入口。Sol 在自身上下文使用已选执行方式，例如 DSH/OpenCode Go `deepseek-v4.1-flash`，并根据原回执等待和验收；不能仅靠设置标签创建原生代理。程序适配宿主可以使用其实际提供的 `options.nativeDirectSol.coordinate`；该回调是否存在、实际调用者及模型须按宿主结果核验。原生接入须有实际 `gpt-6.2-sol`、max 档位及真实代理或任务 ID 的证据。仅有 child-only `dsh-root-pool` 入口的顶层 Sol 不得用结构标签、手填上下文或伪造子代理来绕过该池的身份限制；使用已授权的传统 DSH 入口，或由实际宿主提供权限匹配的真实根池适配器。宿主没有真实直连能力时报告不可用，不伪造成功、不改走 API，也不悄悄加上 Astra 前后环节。

在原生程序适配器中，使用 `dispatchLayeredTask({ source: "subscription", entryStructure: "sol", purpose: "general", prompt, task }, { nativeDirectSol, dsh })`。`nativeDirectSol.coordinate` 由宿主绑定到真实已就绪的 GPT-6.2 Sol Max，而 `dsh` 指已批准的真实执行入口。宿主通过实际调用记录提供 `nativeDirectSol.identity.role`，由原协调器回执提供 `coordinator_receipt.agent_id`、`returned_model` 和 `returned_reasoning_effort`。缺少可核实的调用者角色时仍可记录实际 Sol 模型证据，直连身份保持 `unverified`。宿主读取已验证根的会话设置后，将有效的 `entryStructure` 传给该纯路由接口。

**API 来源**需已获用户明确选择及付费授权，且现有受保护 `sol-coordinator` 和 Windows broker 已就绪。具备能力的宿主可直接调用现有 `run_sol_coordination`，或用 `start_sol_coordination` 后按原键和 ID 调 `get/wait/cancel_sol_coordination`，不创建 Astra 代理作为前置或收尾。示例字段如下，仅在授权与实际入口就绪后使用：

```json
{
  "context": "<当前宿主提供的 context_ref>",
  "idempotencyKey": "<本任务的新非秘密键>",
  "entryStructure": "sol",
  "coordinatorMode": "api",
  "purpose": "general",
  "goal": "<获准的任务目标>",
  "cwd": "<已批准的绝对项目目录>",
  "permissionMode": "read-only",
  "acceptance": "<验收标准>"
}
```

这是一次性覆盖；需要持续切换时使用前述设置入口。订阅不会因选择 `sol` 自动转为 API，API 所有既有授权、工作区和执行能力边界照常适用。

已授权并配置本机的 Antigravity 可以作为 Sol 的纯文本协作者，不能成为新的顶层协调者或通用工具代理。Google 身份、上下文共享、计费及官方支持范围仍按 [Antigravity 文本入口](antigravity-text.md) 核实；未通过无动作隔离门禁时阻断，不改变原 Sol 或执行者归属。

## 身份与验收

记录入口选择、选择依据、实际宿主、来源、接收任务的真实协调者、实际模型和档位、任务回执及结果。`entryStructure`、配置标签、只读解析结果和文字宣称都只是选择或计划，不能证明谁实际处于顶层。对照协调回执中可得的 `entry_caller.role`、`direct_entry.status` 与已验证的线程 kind；`unverified` 表示证据不足，并不等于已证明直接进入 Sol。普通 MCP 入口仅凭上下文区分 root/child，无法由此证明角色，默认报告 `unverified`。可信宿主可在启动时通过 `startSolServer({ identifyEntryCaller })` 根据实际身份记录提供 `user`、`host`、`astra` 或 `sol`；此回调由宿主提供，并非任务参数。确认实际调用者是 Astra 时，新的 `sol` 直连提交会在派发前阻断。协调 MCP 返回 `DIRECT_SOL_ASTRA_CALLER`，原生适配接口返回 `DISPATCH_DIRECT_SOL_ASTRA_CALLER`。不得从任务输入的自报字段推断或伪造 caller 身份。

结构检查、离线测试、宿主工具就绪和真实模型调用分别验收；未连接目标主机、没有订阅直连能力或未获得 API 调用证据时明确报告对应部分未验证。保留原进程和所属任务，不为改变入口结构中断活动工作。
