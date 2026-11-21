# Terra API 受保护入口

当用户明确要求 Terra API 时，本项目固定使用本文件描述的入口：源码为 [`bridges/terra/protected.mjs`](../bridges/terra/protected.mjs)，命令为 [`bridges/terra/cli.mjs`](../bridges/terra/cli.mjs)。不要改用订阅 Sol、ChatGPT 登录、机器环境变量中的 API key、其它 URL 或代理解析。这里的唯一上游路径是本机已安装的 Windows 凭据代理 `../sol/broker.mjs` 的 `brokerCall`；它只接受 `{op:'status'}` 和 `{op:'response',body}`。

API 协议和固定模型/工具契约在 [`client.mjs`](../bridges/terra/client.mjs)：`gpt-6.1-terra`、`reasoning.effort=max`、`confirm_terra_api`、`terra_action`、`finish_terra`。受保护入口构造并返回真实的 `TerraClient`，没有另行实现一套模型协议。

## 固定来源与边界

- 普通用户不能覆盖 URL、API key 或凭据来源、模型、推理档位、transport 或 broker。生产工厂只接受 `actions`、`allowWrite`、`limits`；其它键在发出任何 broker 请求前抛出 `TERRA_OPTIONS_FORBIDDEN`。
- 不从进程环境读取 API key，不回退到订阅，不自动启动服务，不重试未知结果，不把本机日志、凭据或文件内容放进上游请求。
- Terra 的可用性不是靠配置猜测的。只有本机 broker 的真实状态同时满足下列全部条件，才允许发送 Response：

| 字段 | 允许值 |
|---|---|
| `ok` | `true` |
| `status` | `200` |
| `body.ready` | `true` |
| `body.terra_enabled` | `true` |
| `body.terra_model` | `gpt-6.1-terra` |
| `body.terra_reasoning_effort` | `max` |
| `body.terra_tools` | 字符串数组，且包含 `confirm_terra_api`、`terra_action`、`finish_terra` |

- 启用 Terra 时 `body.terra_tools` 必需；缺少任一所需工具、字段不完整或格式错误都不算 ready。保护层会在发送 Responses API 请求前终止，不发出该请求。
- 每次发送 Response 前都会重新读取一次 status。status 查询本身只读、不发送 Response、不计费。因此创建了客户端不等于永久就绪；运行中 broker 变为未就绪时，下一次 Response 会在发送前停止。
- `status` 的本机 `ready` 是确定的就绪检查，不等于一次真实 API 调用成功，也不等于账单结果。

## 导出与可信适配器

```js
import {
  createProtectedTerraClient,
  readTerraStatus,
  summarizeTerraAcceptance,
  TERRA_ACCEPTANCE_ACTION,
  TERRA_ACCEPTANCE_INPUT,
  TERRA_ACCEPTANCE_LIMITS,
  TerraProviderError
} from './bridges/terra/protected.mjs';

const status = await readTerraStatus(); // 只读，无计费
if (!status.ready) throw new Error(status.code);

const client = createProtectedTerraClient({
  actions: [{
    name: 'inspect_contract',        // 预注册的固定操作名
    effect: 'read',
    description: '读取固定的本地契约，不访问文件或网络。',
    callback() { return { ok: true, checked: true }; } // 无参数，本地证据
  }],
  allowWrite: false,                 // 默认 false；需要写操作时由项目单独授权
  limits: { max_rounds: 4, max_actions: 1 }
});
// client 是真实 TerraClient 实例（ProtectedTerraClient extends TerraClient）。
const confirmation = await client.confirm(); // 真正调用 confirm_terra_api，可能计费
```

- `createProtectedTerraClient(options)` 返回真实的 `TerraClient` 子类实例。允许的 options 只有 `actions`、`allowWrite`、`limits`；其中 `actions` 必须是可信项目预先注册的有限操作。TerraClient 的枚举、无参数 callback、重复调用和轮次/用量上限继续生效。
- `client.status()` 或 `readTerraStatus()` 只读取 broker 状态，不发送 Response。
- `client.confirm()` 发送一次带 `confirm_terra_api` 的 Responses 请求；只有真实返回的 `response_id`、`model`、`usage` 才能作为确认证据。
- `client.run({ input })` 先确认，再执行模型选择的预注册操作；模型只能给操作名，不能传路径、命令、脚本或插件。`allowWrite` 默认关闭。任何可能计费的动作都必须先取得用户明确的计费同意。
- `createTerraTestHarness(options)` 仅用于离线测试，接受注入的 `callBroker`，不是生产适配器入口，不要在项目中用它绕过 broker。生产入口会拒绝这种覆盖。
- `TerraProviderError` 是受保护层对 broker/上游失败的脱敏结构；其它协议校验失败仍为 `TerraError`。

## CLI

```powershell
node bridges/terra/cli.mjs status
node bridges/terra/cli.mjs verify-api --accept-terra-charges
node bridges/terra/cli.mjs acceptance --accept-terra-charges
```

### `status`（只读，不计费）

只发送 `{op:'status'}`，绝不发送 `{op:'response',body}`。输出 broker 状态的白名单字段、`billing:"none"` 和说明。退出码：`0` 为已就绪，`1` 为未就绪/错误，`2` 为命令用法错误。status 通过不能替代 verify-api 或 acceptance 的真实调用证据。

### `verify-api`（显式计费同意）

必须带有精确的 `--accept-terra-charges`。命令先做只读 preflight status；未就绪时退出 `1` 且不发送 Response。就绪后通过真实 `TerraClient.confirm()` 发出一次 `confirm_terra_api`，只有实际返回的 `resp_...`、`gpt-6.1-terra` 和 usage 才写入成功报告：

```json
{
  "command": "verify-api",
  "ok": true,
  "status": "verified",
  "confirmed": true,
  "response_id": "resp_...",
  "model": "gpt-6.1-terra",
  "reasoning_effort": "max",
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "confirm_tool": "confirm_terra_api",
  "billing": "incurred"
}
```

成功响应中的 token 数是该 Responses 返回的 metadata，不是账单。模拟 ID、离线 mock 或 status 的 `ready` 都不能写进实机成功证据。

### `acceptance`（显式计费同意，有界只读）

同样必须带 `--accept-terra-charges`。使用固定的 `TERRA_ACCEPTANCE_INPUT`、唯一预注册的只读动作 `inspect_contract` 和固定的 `TERRA_ACCEPTANCE_LIMITS`：

| 限制 | 值 |
|---|---|
| `max_rounds` | 4 |
| `max_actions` | 1 |
| `max_output_tokens` | 512 |
| `max_total_tokens` | 6000 |
| `max_input_bytes` | 16000 |
| `max_report_bytes` | 1200 |

固定动作只读取本地契约常量并返回固定结果，不访问文件、网络、命令、脚本、日志或凭据；模型报告只作为有界的 `model_report` 展示，`summary` 的成功证据是 `confirm_terra_api` 轮次加上该只读动作的本地 callback receipt。没有 receipt、没有确认轮次或 usage 无效时，命令报告失败（`TERRA_ACCEPTANCE_INCOMPLETE`），不会把模型文字当成验收。

验收成功报告包含 `response_ids`、`rounds`、实际 `usage`、`action.checks` 和 `billing:"incurred"`。任何可能计费的验收都必须先有用户明确同意；离线 mock 运行不等于实机通过。

### 三类报告不能互相替代

- `status` 只证明本机 broker 那一刻的只读状态，不证明真实 Terra 请求成功，不产生 Response ID。
- `verify-api` 只证明一次 `confirm_terra_api` 确认请求；它不证明只读动作验收。
- `acceptance` 只证明固定、有界的只读动作运行；它不是任意项目操作或写能力的验收。
- 缺少实际 response ID、返回模型或 usage 时，不得报告 API 成功。没有真实计费授权时，只能报告相关检查未执行。

## 失败结构、脱敏与 known/unknown

broker 或 provider 失败时，CLI/受保护层只输出白名单字段：

```json
{
  "command": "verify-api",
  "ok": false,
  "status": "failed",
  "phase": "response",
  "error": {
    "code": "UPSTREAM_HTTP",
    "status": 500,
    "known": false,
    "usage_unknown": true,
    "request_sent": true,
    "usage": null,
    "response_ids": []
  },
  "billing": "unknown"
}
```

- `code`：保留安全的 broker 错误码或 `UPSTREAM_HTTP`；不安全/未知编码归为 `TERRA_BROKER_UNKNOWN`。
- `status`：保留 100–599 的 HTTP/代理状态；无效值置 `null`。
- `known:true`：只有确定的本地未发送（未就绪、凭据/配额/策略拒绝等），本次不会产生 upstream 用量。已知未发送时 `usage_unknown:false`、`request_sent:false`。
- `known:false` / `usage_unknown:true`：传输中断、未知编码、broker 结果不明或上游 HTTP 失败。不能据此编造已知状态或 usage；`request_sent` 可能是 `true`、`false` 或 `null`。
- 不输出原始 broker 报文、stderr、日志、凭据或上游错误正文；code 必须是安全标识符。
- `upstream HTTP` 失败视为已发送但用量未知，不把 4xx/5xx 的失败伪造成零用量。

TerraClient 自身校验失败（如 `TERRA_ROUTE_MISMATCH`、`TERRA_INCOMPLETE`、`TERRA_TOOL_ARGUMENTS`）保留其 `TerraError.code`；只有实际存在的 evidence/usage 才写入报告，缺少时标为未知。

## 从既有 Sol 安装启用 Terra（受保护升级）

升级仍从普通入口 `scripts/setup-sol.ps1` 开始。在仓库根目录设置可移植路径后，先在目标机预览（只读；`-Apply` 才请求 UAC）：

```powershell
Set-Location '<repository-root>'
$repo = (Get-Location).Path
& (Join-Path $repo 'scripts\setup-sol.ps1') -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi
```

服务已停止时，正常应用命令是：

```powershell
& (Join-Path $repo 'scripts\setup-sol.ps1') -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -Apply
```

服务正在运行时，默认 apply 拒绝停服。明确同意一次短维护窗口内的短暂停服后，使用：

```powershell
& (Join-Path $repo 'scripts\setup-sol.ps1') -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -AllowBriefRestart -Apply
```

`-AllowBriefRestart` 只与 `-EnableTerraApi -Apply` 组合有效；不能从配置、默认值、交互提示或其它开关推导。它不会进入普通 Sol 安装或普通 `elevation`，也不会传给非受保护源码。

受保护链为：普通入口 → 固定提交源码 bundle（`sol-setup.mjs` 校验并冻结 `install.ps1`/`build.ps1`/C#/bootstrap）→ UAC 提权引导 → 受保护暂存目录中的 `install.ps1 -EnableTerraApi [-AllowBriefRestart]`。安装器先编译候选、备份旧 exe/policy、校验策略字段，再做本机门槛：核对服务注册的固定映像路径和服务账号、稳定的 Running/Stopped 状态及 PID。Running 且无 consent 时拒绝；Running 且有 consent 时，以数次短间隔只读采样受保护 `SolBroker.exe` client 进程，任何忙、路径/身份不清或状态/PID 变化都拒绝，且不杀调用者、不强制停依赖服务。仅在最终复核后短暂停服一次，替换后按原状态启动一次。

原已停止的服务保持停止，不启动也不停止；成功输出会注明没有运行服务身份/DPAPI 检查。任何失败都先恢复旧 exe/policy 并校验 ACL/哈希，再恢复原先运行状态；若停服已发生但替换前失败，也会启动回原运行状态。SCM 或磁盘恢复失败、启动状态不清时保留事务目录和 `ROLLBACK-FAILED.txt`，报告实际状态，不强停或假报恢复。

限制：旧服务的 `OnStop` 会取消仍在途的 API 请求，且没有原子 drain/refusal barrier。上述只读采样不能消除“最终检查后、停服前有新调用开始”的竞态，因此只能在短维护窗口使用，默认绝不自动停服。成功升级的备份目录在正常清理时删除；需要保留的证据应在操作前另行记录。

## 每小时滚动配额（全新安装 100；历史缺失字段 24）

全新的受保护 Windows broker 安装由 `install.ps1` 显式写入 `requests_per_hour=100`，而不是依赖字段缺失时的旧默认值。正常安装预览的 `status.broker_quota` 会报告 `new_protected_install=100` 与 `legacy_missing_field=24`。允许范围为 `1..1000`。

既有机器遵循以下规则：

- `policy.json` 有显式 `requests_per_hour` 时（例如之前选择的 `96`，或更高的机器限额），普通重跑、刷新和没有显式改额度的 Terra 升级都会保留该值；预览的 `requests_per_hour.current` 报告实际值，不会把旧服务显示成 100。
- 旧策略完全没有该字段时，broker 和预览仍按历史契约解释为 `24`；预览标记 `current_source=legacy-missing-field`。只有真正执行下面的显式升级并成功替换受保护的 `SolBroker.exe` 和 `policy.json` 后，旧机器才会变成 `100`。
- 安装器只接受提高，拒绝降低；若既有显式值高于 `100`，请求 `100` 会被拒绝并保留原值。仅预览、仅改配置、仅改策略文本都不算生效；必须走受保护安装器并验证真实只读 `status`。

在仓库根目录先做只读预览（不写策略、不停服、不调用模型）：

```powershell
Set-Location '<repository-root>'
$repo = (Get-Location).Path
& (Join-Path $repo 'scripts\setup-sol.ps1') -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -RequestsPerHour 100
```

服务已处于停止状态时：

```powershell
& (Join-Path $repo 'scripts\setup-sol.ps1') -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -RequestsPerHour 100 -Apply
```

服务正在运行时，必须显式同意一次短维护窗口内的短暂停服（忙时、状态变化、路径/身份不清都会拒绝；不会杀调用者）：

```powershell
& (Join-Path $repo 'scripts\setup-sol.ps1') -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -RequestsPerHour 100 -AllowBriefRestart -Apply
```

`<reviewed-40-char-sha>` 必须是包含这些源码改动的已审核提交；未提交或未审核的源码不会被固定提交校验接受。`-RequestsPerHour` 只与 `-EnableTerraApi` 一起使用。只写 `-EnableTerraApi` 不会自动把旧机器的 `24`（或既有的 `96`、更高值）改成 `100`；升级到 `100` 必须显式请求。`96` 只作为既有安装可能保留的先前值示例，不再是新安装默认值。

受保护升级在编译候选、备份、策略字段和固定服务/身份/状态校验通过后，替换 `SolBroker.exe` 与 `policy.json`，再按原先 Running/Stopped 状态处理；不会初始化、清空或改写 `state\rate.bin`、`audit.jsonl`、凭据或滚动窗口记录。滚动窗口跨重启保留，满一小时后释放较早记录。

独立只读验证（通过普通 broker 状态入口，不需要密钥或模型调用）：

```powershell
Set-Location '<repository-root>'
node --input-type=module -e "import { brokerCall } from './bridges/sol/broker.mjs'; console.log(JSON.stringify(await brokerCall({ op: 'status' }, AbortSignal.timeout(20000)), null, 2));"
```

成功升级后响应中的 `body.requests_per_hour` 应为 `100`；仍在运行的旧缺失字段服务则仍是 `24`，直到上述显式升级真正成功。`body.terra_enabled` 等既有字段不变，`body.ready` 仍只表示运行凭据是否可用。

## 验证边界

- 源码、离线 fixture 和模拟安装结果不能替代目标机的真实安装/升级证据。新安装或升级完成后，应以目标机实际 `policy.json`、受保护 `SolBroker.exe` 的只读 `status` 和滚动窗口记录为准。
- 配额预览与 `status` 都是只读的，不发送 Response、不产生计费调用。运行中的旧服务在成功执行显式升级前仍按其实际策略计数；不得把预览、源码或计划值报告为已生效。
- 未获得真实计费授权时，只能报告相关 `verify-api`/`acceptance` 检查未执行。测试 fixture 中的 response ID/usage 只是模拟数据，不是实机通过记录或账单证据。
- 需要实机确认时，先由获准用户运行 `status`；只有 `ready:true` 且上述 Terra 字段与 `terra_tools` 全部满足，才可讨论一次显式同意的 `verify-api`。实际计费与额度以真实 Responses 回执和账单为准。
