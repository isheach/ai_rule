# DSH → HY4 预准入回退策略（已接入；临时标准 stdio 已验证；非每机部署）

策略版本：`2026-11-13.hy4-preadmission-r1`  
实现：`bridges/dsh/routing.mjs`  
状态：**opt-in 临时标准 stdio MCP 已把隔离 DSH 预准入拒绝路由到官方中国 CodeBuddy 2.184.0 ACP 的 `hy4free`（同一原始账号）。** 已验证 native 文件、一次授权命令和最终免费目录 guard；未声明每台机器已注册/宿主已加载、命令均经 ACP 授权、桌面 app、OS 隔离或 provider billing。

本策略只回应一个窄问题：DSH 在**任务受理之前**被明确门禁拒绝，且本机已有用户显式授权时，是否允许把同一个请求交给 HY4 一次。它不是通用模型回退，也不是日程绕过。

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| DSH 是否仍是默认主后端？ | 是。`session_mode=DSH` 保持，显式 HY4 选择也保持。 |
| 是否新增了可审计的策略/协调器？ | 是，`routing.mjs`，含结构化预准入拒绝、授权校验、单次回退、决策回执、幂等/并发保护。 |
| 是否已接入实际 MCP 工具调用？ | **是，在 opt-in `bridges/hy4/server.mjs` 与临时标准 stdio pool 中**；DSH 预准入拒绝后实际转 HY4。每台机器仍需自行注册/宿主加载，不能声称全局已部署。 |
| 是否建立了真实 HY4 入口？ | **是**：官方中国 CodeBuddy Code 2.184.0 ACP，原账号，固定 `hy4free`；当前 catalog 必须明示 `x0.00 credits`，不做 `hy4std`/auto 回退。 |
| 是否有真实 HY4 调用/付费测试？ | 有真实 HY4 native 文件、一次无害 PowerShell 命令和最终目录 guard 调用；不据此证明 provider billing 或永久免费。 |
| 已安装日程是否改变？ | 否。没有改既有配置、注册、peak 策略或 WorkBuddy 安装。 |

## 2. 允许回退的闭集

只有 `PreAdmissionRejection` 且 `admission_state=not_accepted` 的以下代码可以进入回退判断：

| 代码 | 含义 | 是否可回退 |
|---|---|---|
| `DSH_SCHEDULE_GATE` | 本地峰时/预峰门禁拒绝新任务，或预算跨越 hard stop；尚未创建任务 | 是，需显式授权、HY4 ready，并显式选择受支持的 `text-only`/`workspace-read`/`workspace-write` 且 permission/scope 匹配本地策略 |
| `DSH_PRE_ACCEPTANCE_UNAVAILABLE` | 受支持的预准入 auth/quota/可达性探测明确报告不可用，且 `task_accepted=false` | 仅当证据含 `provider_check=supported`、`task_accepted=false`、`cause∈{auth_rejected,quota_exhausted,provider_unreachable}`，且能力/permission/scope 匹配；当前仍未接入该探测 |

当前桥接器**没有**接入第二行的 auth/quota 探测；因此它不能用普通 CLI 错误冒充。已测试的正式路径是显式 capability + matching permission/scope，不再限定为 text-only。

DSH 核心已调整为：幂等回执读取 → 同实例 busy → `active.lock` 独占 → session ownership → 日程/预算门禁 → preflight。日程门禁不再先于外部锁/会话检查，因此 live/unknown lock 或 session 冲突不会被伪装成可回退的 `DSH_SCHEDULE_GATE`。拒绝时释放本次刚创建的锁，不删除任何既有锁。

## 3. 永不回退的情形

以下均不满足“已证明未受理”，或属于策略/权限/输入问题，保持原后端并报告：

- 任务已受理（`accepted`）：包括 idempotent 提交已返回 task_id；之后即使超时、断开、配额/认证失败，也在原 DSH 后端处理。
- 运行中、正在取消、`unknown_after_disconnect`、结果/回执未知、网络超时、可能已产生副作用。
- 权限/策略/审批拒绝（`DSH_PERMISSION_REFUSED`）、参数非法（`DSH_INVALID_PARAMS`）、会话冲突（`DSH_SESSION_CONFLICT`）。
- **任何带 `sessionId` 的请求，或显式 `continuationOfTaskId`/`repairOfTaskId` 的继续/修复请求**：始终锁定 DSH，即使日程门禁拒绝也不得转 HY4。
- 同实例 busy（`DSH_BUSY`）或跨进程锁（`DSH_LOCKED`）：作为独立类别，**本阶段不自动回退**。没有“证明不是同一工作重复提交”的安全证据，因此不实现猜测式回退。
- 预检失败（`DSH_PREFLIGHT_FAILED`）或任何非结构化错误：可能发生在 spawn 之后，标记 `unknown`，禁止回退/重试。
- 停止、取消、部分结果、`schedule_stopped`。
- 显式 HY4 选择而 HY4 不可用：报阻塞，不回退 DSH。

任何普通 `Error` 或字符串都不参与资格判断；`isFallbackEligible()` 只检查结构化对象和闭集代码。

## 4. 授权契约

默认关闭。启用必须提供类似：

```json
{
  "schema": 1,
  "enabled": true,
  "authorization_ref": "user-approval-2026-11-13",
  "scope": "pre_admission_only",
  "max_attempts": 1
}
```

- `authorization_ref` 是非秘密的本地批准引用，不是令牌，也不能由模型自造。
- `scope` 必须是 `pre_admission_only`；`max_attempts` 必须为 1。
- 没有配置时回退结果为 `FALLBACK_NOT_AUTHORIZED`，HY4 适配器不会被调用。
- 本仓库未把该配置写入任何已安装 MCP 注册；这是有意的。

## 5. 决策回执

每次受理尝试在 runtime 的 `routing/<sha256(idempotencyKey)>.json` 写入：

- `request_id`（UUID）、`idempotency_key` / `idempotency_key_sha256`、`request_fingerprint`
- `session_mode`、`requested_backend`、`selected_backend`
- `admission_state`：`not_accepted` / `dispatching` / `accepted` / `unknown`
- `reason_code`、`reason`、`dsh`/`hy4` 的 state/code/task_id
- `fallback.authorized/eligible/attempted/hy4_ready/result`
- `prompt_sha256`、cwd、permission mode、时间戳

不保存 prompt 原文、凭据、token、原始错误文本、适配器 `error.message`、HY4 `missing_entry`/原始状态文本或工具输出。只能写入闭集原因码和本地固定说明；adapter 返回的 task status 只保留白名单值。回执可审计但不等同于服务端模型/账单证明。

## 6. 并发、幂等与客户端兼容

- 每个幂等键在调用任一后端前，先以 `routing/<sha256(key)>.claim` 的 `wx` 独占创建跨进程 durable claim，并 fsync；随后才发布 `dispatching` 决策并调用后端。claim 不自动删除；崩溃、部分写入或回执缺失都会永久 fail-closed。
- 同一进程内同 key 并发提交通过 single-flight 合并；不同参数/模式即使第一个 promise 失败也直接报冲突。
- 决策文件 `dispatching` 或 claim 存在但回执不可读：后续提交得到 `ROUTING_IN_FLIGHT_OR_UNKNOWN`，不重提、不回退、不删 claim。
- 已受理的决策在峰时仍可直接按幂等键读取，不触发新的 DSH/HY4 调用。
- 同 key 不同参数或不同请求后端/模式得到 `ROUTING_IDEMPOTENCY_CONFLICT`；修订必须使用新 key，不能跨模式复用。
- 回退只尝试一次；HY4 接收后锁定 HY4，不回 DSH。HY4 失败且可能已受理时标记 `unknown`，不重试。
- 回退不自动恢复、不迁移已运行任务；重试/监守使用最终接收的后端。
- 受理后若回执写失败，claim 保持存在，后续不得因“找不到回执”而重提。
- MCP 错误仍返回 `isError: true` 的文本内容，v0.3.0 客户端不会被改成静默成功；新客户端另得 `structuredContent.error`（code、admission_state、fallback_eligible、details）。

## 7. 真实 HY4 证据与剩余限制

已通过 opt-in 临时标准 stdio MCP 实际验证：

- DSH 在隔离预准入拒绝后转官方中国 CodeBuddy 2.184.0 ACP `hy4free`，DSH 零模型请求。
- native 文件任务 `562f7540-1ccb-4dea-96e8-84989656cc48` completed/end_turn：两次 Read、一次自主 create、一次精确 Edit。
- 显式授权无害 PowerShell 任务 `07ee1a25-76cb-422a-b0b8-9f49d82d116b` completed；vendor 默认 auto-allow，独立核对文件未变。
- 最终价格 guard native Read 任务 `1f0d3538-de2c-48f8-91e2-4f6b6994327d` completed/end_turn，receipt `free_catalog_verified`。
- 当前 catalog 对 hy4free 必须明示 `x0.00 credits`；目录价是准入证据，不是账单/provider attestation。

剩余限制：未声明每台机器已注册/宿主已加载；不是所有命令都经 ACP permission callback；不证明桌面 app、OS 隔离、多聊天 identity、认证或 provider billing。命令默认关闭，需本地 manifest 和逐条 literal 授权。

## 8. Root-chat pool（已实现并临时 stdio 验证；按需 opt-in）

实现与注册步骤见 `docs/root-pool.md`。临时标准 stdio 已验证一个真实根的两个批准 cwd DSH 任务、同 instance/runtime 的 fresh sessions 和幂等 lookup，以及 alpha/bravo 两个真实注册实例并行；独立合成根仍只用 actual mock stdio。

保留以下约束：

- root chat ID 由 Codex host parent chain 核实；不猜 ID，不假定 stdio 注入。
- 原子 lowest-free 绑定；可选 binding cap。
- 独立可配置 running cap（默认 3），与 binding 数分开。
- 可配置 idle TTL，默认 24h。
- 每个 root 独立 runtime/history/DSH session。
- active/start/uncertain 锁固定 owner；generation + lease capability 保护操作，chat ID 仅路由。
- 现有 default/named/manual 服务保持隔离。
- 每台机器仍需自行 opt-in 注册、空闲时 reload 并确认实际工具列表；不自动创建实例或改安装注册。

## 9. 验证状态

测试文件：`tests/routing.test.mjs`（合法/禁止回退、显式 HY4、busy/lock、预准入探测、幂等并发、峰时查询、字符串伪造、HY4 不可用、两个协调器共享 claim、阻塞中的 `dispatching` 状态、受理后回执写失败、跨模式复用冲突、session/继续/修复锁定 DSH、回执秘密泄漏）与 `tests/framework.test.mjs`（结构化错误、MCP 文本+结构化错误、live mock MCP 峰时 `phase`/`hard_stop_at` 元数据、日程前外部锁不被掩盖）。

实际执行：113/113 isolated mocks 通过，0 skipped，包括 opt-in native command fakes。公开命令示例只从仓库根运行，不包含本机路径：

```powershell
npm test
```
