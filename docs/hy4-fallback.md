# DSH → HY4 预准入回退

策略源 `bridges/dsh/routing.mjs`。适用于已明确授权的 DSH 模式 3 根池或使用显式日历的独立 ACP 组合入口。执行前的判断见 [HY4 操作参考](../skills/multi-agent-dispatch/references/hy4.md#dsh-预准入回退)。

## 配置授权

默认关闭。授权需要真实本地批准引用，限定 `pre_admission_only`、一次尝试。做法取决于已使用的入口。

| 本机入口 | 配置 |
|---|---|
| DSH 根池，包括 API Sol 所配同类根池 | 在本机根池 JSON 同时设置 `hy4_manifest`、`fallback_authorization_ref`，为获准会话选择模式 3。 |
| 独立 ACP 组合入口 | 配置实际 `--schedule-config` 及 `--fallback-authorization <本机非秘密批准引用>`。 |
| 传统 `dsh-opencode-go` 或命名 DSH 服务 | 使用原服务的结构化门禁回执。需要自动回退时显式配置有 ACP 适配器的入口。 |

本地批准引用供回执审计。HY4 仍要满足其 CLI pin、免费目录、task capability、原工作目录和范围。 [根池配置](root-pool.md) · [ACP 配置](codebuddy-acp.md)

## 结构化准入

| `not_accepted` 原因码 | 证据 |
|---|---|
| `DSH_SCHEDULE_GATE` | 原日历实际峰时、峰前门禁或预算拒绝。既有实例、锁与继续请求的校验仍生效。 |
| `DSH_PRE_ACCEPTANCE_UNAVAILABLE` | 策略支持 `provider_check: "supported"`、`task_accepted: false` 与 `auth_rejected`、`quota_exhausted` 或 `provider_unreachable`。当前运行入口没有接入这种探测。 |

「未受理」仅来自结构化结果。普通 CLI 错误文本、锁、忙碌、权限、参数、会话冲突、继续或修复请求均按原状态处理。模式 2 的 WorkBuddy 路由以及峰前和谷时预算拒绝由 [峰谷日历](offpeak-schedule.md) 处理。

## 回执与诊断

- `routing/<sha256(idempotencyKey)>.claim` 先独占预留，再写 `dispatching` 决定并调用后端。同一请求 single-flight，终态通过原键重放。不同参数或范围的同键请求冲突。受理信息缺失时保留 claim 和原回执以供核实。
- `routing/<sha256(idempotencyKey)>.json` 有 `request_id`、键或键哈希、请求指纹、选定后端、`admission_state`、闭集原因码和 HY4 是否授权、符合条件、尝试及结果。回执保存受控诊断及元数据，任务正文、原始错误和凭据不随决定持久化。
- 拒绝和未知有 `structuredContent.error` 及可读错误内容。`dispatching` 或 `ROUTING_IN_FLIGHT_OR_UNKNOWN` 要沿原键检查判定、进程和回执。原后端受理后由其所有者处理。

`tests/routing.test.mjs`、`tests/framework.test.mjs` 和池 stdio 回归覆盖资格、并发与恢复。既有真实临时 stdio 验收在隔离 DSH 门禁拒绝后由官方 ACP `hy4free` 完成授权文件任务，DSH 未发模型请求。每台机器的授权、安装、调用归属和实际结果分别验收。 [ACP 验证](codebuddy-acp.md#验证)
