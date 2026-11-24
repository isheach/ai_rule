<!-- ai-rule-managed: 2026-11-24.plan-b-r1 -->
# 会话入口结构

`entryStructure` 可取 `astra` 或 `sol`，与 `coordinator_mode`（订阅/API）、`session_mode`（A/DSH/WorkBuddy DSF/HY4）及 `scheduleMode` 独立。根记录没有该字段时兼容默认 `astra`。持久切换仅影响同一已验证根的新任务；仅本次覆盖不改根的选择。已受理任务保留原结构、来源、后端、所有者、权限、ID、键、会话、状态与证据，不自动迁移或重提。

- `astra`：沿原规则由 Astra 接收并交给实际 Sol，或按原专家路由交 Terra/Antigravity；原接手者负责研究、执行和验收，Astra 按原入口等待并汇报。
- `sol`：一般任务由用户或具备真实直连能力的宿主直接进入 GPT-6.2 Sol Max，Sol 规划、调用所选执行入口、等待、验收并向用户/宿主汇报；不加 Astra 代理作前后环节。订阅与 API 分别按所选来源与授权执行，不能仅凭字段或标签声称直连成功。明确专家目的的 Terra 或 Antigravity 任务仍沿原专家路由，是否经过 Sol 以实际回执为准。

`sol` 不是 A 模式：例如 `entryStructure: "sol"` 可与订阅 Sol → DSH 同时成立，Sol 仍由实际 DSH Harness 执行。A 模式表示原生 Sol 自己执行与自审；API/A 等既有限制继续有效。没有真正直连能力时报告受阻，不假造模型或改源。核对协调回执中可得的 `entry_caller.role`、`direct_entry.status` 与已验证线程 kind；`unverified` 不是直连证明。普通 MCP 仅凭上下文识别 root/child，角色默认 `unverified`。可信宿主可在 `startSolServer({ identifyEntryCaller })` 中按真实身份记录提供 `user`、`host`、`astra` 或 `sol`，任务参数不可声明角色。确认新 `sol` 直连的实际调用者是 Astra 时返回 `DIRECT_SOL_ASTRA_CALLER`，应照实报告。

## 选择与操作

在实际宿主从已注册的 `sol-coordinator` 获取并验证 `context_ref`，把它作为 `context`；过期在同一宿主刷新，不手填根、父链或 lease。订阅 Sol 与其他持有合适入口的宿主按同一根上下文执行。上下文获取方式仍按 Skill 与当前注册。

1. `get_sol_entry_structure({ context })` 读取当前根的选择，`get_sol_coordinator_mode({ context })` 也并列报告来源与入口结构；关注 `entry_structure` 和 `entry_structure_source`，不要把选择当成执行证据。持久切换时，用户明确要求后使用 `set_sol_entry_structure({ context, entryStructure: "sol" })` 或传 `"astra"`，仅影响后续新任务。
2. 仅本次覆盖在 `start_sol_coordination`、`run_sol_coordination` 或只读 `resolve_layer_dispatch` 的 handoff 传 `entryStructure`；省略使用同一根的持久选择，旧记录缺字段为 `astra`。来源、执行模式和日程选择照原值执行。只读解析不会调用模型，不能证明实际顶层身份或就绪。
3. API Sol 直接结构由实际宿主通过现有 `run/start_sol_coordination` 提交并等待原任务，仍需用户明确 API 选择、计费授权及原工作区权限。订阅 Sol 的直接结构只在宿主提供真实 `gpt-6.2-sol`、max 模型入口时使用；程序化宿主可按实际提供的 `options.nativeDirectSol.coordinate` 接入。原生适配器须有真实 Sol 模型、max 档位和实际代理或任务 ID 的证据。原 Sol 决定并实际使用 DSH 等所选执行入口，按原回执验收。若直接 Sol 在顶层只有 child-only `dsh-root-pool`，不靠结构标签或伪造子代理绕过身份限制；使用已授权的传统 DSH 或真实宿主提供的权限匹配池适配器。

在保存自身 rollout 的实际 Codex 宿主，可用真实配置绝对路径和宿主的 `CODEX_THREAD_ID` 核验同一根并查看或持久设置入口；两条命令不调用模型：

```sh
node bridges/sol/cli.mjs entry-structure-status --config <ABS>
node bridges/sol/cli.mjs set-entry-structure --config <ABS> sol
```

第二条末尾改为 `astra` 即切回旧结构。普通 shell 缺少宿主线程证据时不能凭手填根或 ID 宣称切换成功；仅本次覆盖不调用持久设置。

已授权且本机已配置的 Antigravity 可被 Sol 用作纯文本协作者，不承担顶层协调或通用动作。Google 的身份、上下文、计费、官方支持范围及无工具隔离条件见 [Antigravity 纯文本路由](antigravity-text.md)。无对应能力或证据时报告未完成。

只读解析示例：

```sh
node bridges/dispatch/cli.mjs resolve --entry-structure sol --source subscription --purpose general
```

记录选择依据与实际宿主的调用证据，并分别报告源码、安装结构、真实宿主就绪和获准模型调用；旧任务按原入口、原键和原回执恢复。选择 `sol` 不能代替真实入口、权限或调用者证据。
