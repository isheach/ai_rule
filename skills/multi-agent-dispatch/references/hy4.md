<!-- ai-rule-managed: 2026-11-20.unified-dispatch-r1 -->
# HY4 与预准入回退

## 显式 HY4

在订阅 Sol 中使用本机已验证的 HY4 入口。官方 CodeBuddy ACP 入口从 `get_hy4_bridge_status` 核验 readiness，使用 `run/start_hy4_task` 和同一入口的 `get/wait/cancel_hy4_task`。每次新握手在发 prompt 前核对 CLI 版本和哈希、模型目录明确的 `hy4free`（Hy4） `x0.00 credits` 与选择回执。缺失或不匹配时停止。目录价格用作准入证据，实际计费以账单为准。

| `capability` | `permissionMode` | 任务范围 |
|---|---|---|
| `text-only` | `read-only` | 文本任务，无文件或命令工具 |
| `workspace-read` | `read-only` | manifest 开启读能力，现有批准的 canonical cwd |
| `workspace-write` | `workspace-write` | manifest 开启写能力，批准的 canonical cwd、`authorizationNote` 及明确的文件或命令范围 |

选择任务实际需要的能力。目录 `writeScopes` 使用现有目录和 `create`/`replace`/`edit` 子集。精确文件 `writes` 使用 `create`/`edit`/`write`，可选 `content_sha256` 仅适用于写入完整内容，正常任务可由执行者自行生成内容。写入使用与真实工具调用匹配的 `allow_once`。应收到实际完成状态，混合或拒绝终态按回执报告。

官方 ACP 任务 `timeoutMs` 默认和上限均为 `900000`。每项任务使用新的 ACP 会话，按其原任务 ID 查回执。修订由同一入口接收已批准上下文并用新任务键派发。

命令仅在本机 manifest 开启命令并配置 hook，且任务的 `commands` 逐条授权时使用。ACP 写权限回调与厂商默认可能自动放行的安全命令各有约束。按实际命令检查和宿主隔离验收。

历史 `hy4-workbuddy` 使用其自身已加载的 schema、已批准能力和模型设置。旧桥 `hy4-preview` 与官方 ACP 的 `hy4free` 是两个入口。向某个入口派发后按其实际生命周期处理。显式 HY4 失效时报告阻塞。

## DSH 预准入回退

模式 3 的根池及按显式日历使用的 ACP 组合入口可以执行本机已获批准的回退。回退由原 Sol 沿同一已配置的路由发起，维护 DSH 会话选择。依次核对以下条件：

1. 请求是新任务，保留原 cwd 和批准范围。带 `sessionId` 或 WorkBuddy continuation 的请求，及继续、修复既有工作，保持原执行者。
2. DSH 在受理前返回结构化 `not_accepted`；准入代码为 `DSH_SCHEDULE_GATE`。策略也识别带 `provider_check=supported`、`task_accepted=false` 和已知原因的 `DSH_PRE_ACCEPTANCE_UNAVAILABLE`，当前运行入口未接此类探测。普通错误、配额文本、锁或权限拒绝无法满足回退条件。
3. 原 DSH 未取得任务 ID、子进程或本次受理回执。已受理、受理不明、断连、超时、已停止和部分结果都走原记录的恢复流程。
4. 本机有真实批准引用，明确 `pre_admission_only`、最多一次。官方 ACP readiness、模型、目录价和本次 HY4 能力及范围均通过核验。任一条件缺失，沿用原阻塞回执。
5. 使用同一幂等请求由桥记录原因码、预准入与回退结果。HY4 开始后沿回执保持 HY4。发生未知结果时查原入口，禁止换键重提。
