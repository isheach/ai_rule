<!-- ai-rule-managed: 2026-11-23.astra-handoff-r1 -->
# 模式 2 峰时 WorkBuddy DSF 交接

这是模式 2 的既有显式交接路径，不是全新会话的默认底层。只有已选择模式 2 且进入实际峰段时才使用；不因全新默认或 Terra 专家任务自动启用，也不改写已受理任务的所有者。

此流程在 [DSH 模式 2](dsh.md#schedulemode-如何作用) 的实际峰段使用。已受理任务继续由原执行者处理。订阅 Sol 执行下列步骤。API Sol 通过本机已配置的 WorkBuddy DSF 连接完成同一领取和回填合同。

1. 用正常 DSH 入口提交获准任务和原 `idempotencyKey`。合格的峰时请求返回 `status: "workbuddy_pending"` 及 `workbuddy_dispatch`，此时还没有执行任务 ID。峰前、谷时预算拒绝、已受理、DSH 续跑、锁冲突与权限拒绝按原入口处理。
2. 按 [WorkBuddy DSF](workbuddy.md) 核对加载的服务 ready、固定模型 `deepseek-v4-flash` 以及原 cwd、项目和权限范围。项目入口从状态回执取得 `project_id`，定制入口使用实际已授权 profile。服务或权限不足时，用原 DSH 入口的 `finish_workbuddy_dsf_dispatch` 记录 `unavailable` 或 `refused`。
3. 在调用执行者前，通过原 DSH 入口用 `claim_workbuddy_dsf_dispatch` 传原 `idempotencyKey`、`dispatchId`，根池还传有效 `context`。桥复查峰段。拿到 `claimed: true` 和 `claimToken` 后，在 `expires_at` 前调用一次 `run_workbuddy_task`，保留原任务、原键和授权边界。未调用且期限已过时，用原 token 回填 `refused`。
4. 使用 `finish_workbuddy_dsf_dispatch` 和原 `claimToken` 回填真实终态、`backendTaskId`、`backendSessionId` 及可共享答复。断连或受理不明时记录 `unknown_after_disconnect`，用 `get_workbuddy_dsf_dispatch` 和原键跟踪。项目入口按 `get_workbuddy_task` 核验原执行回执。未知、重复领取、重放或已取消时查原记录，禁止重复发起 WorkBuddy。
5. 在传统实例上切出模式 2 时，将该会话尚未领取的交接回填 `cancelled`。对已领取的执行，用 WorkBuddy 实际支持的生命周期接口和原所有者处理。下一项独立谷时任务按 DSH 正常调度。

用户明确在实际峰段继续 WorkBuddy 时，使用同目录已完成交接的 `workBuddyContinuationKey` 和新的 `idempotencyKey`。读取原回填的 WorkBuddy 会话 ID，按该入口已验证的续跑能力提交。API Sol 同一协调任务内的修订使用适配器的原会话继续能力。不能核实原后端或会话时报告阻塞。
