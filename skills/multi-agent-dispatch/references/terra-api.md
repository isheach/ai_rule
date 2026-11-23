<!-- ai-rule-managed: 2026-11-23.luna-peer-api-r1 -->
# Terra 专家入口

Terra 用于用户明确交给 GPT-6.1 Terra Max 的专家任务：主机操作/验收、写作、绘图或图像生成与识别。Terra 使用与 Sol 相同的已选中间来源；不得因 Terra 不可用自动改走 DSF、Sol 或另一来源。

此页记录直接专家入口。Sol 调用 Terra 协作的步骤和继承边界见 [调度 Skill](../SKILL.md#由-sol-调用-terra-或-luna)。

## 订阅来源

只在宿主实际提供 Terra 代理、CUA/主机工具或图像工具时执行，并核对实际模型、档位和工具。纯写作可直接返回文本，不虚构工具动作。主机操作/验收、图像生成或识别只通过实际提供的工具；证据取本地工具回执或调用记录。限定范围的 CUA 工作完成、失败或取消后关闭该范围，不影响无关窗口、进程或任务。宿主缺少所需能力时报告不可用，不声称通用桌面或图像驱动。

## API 来源：固定受保护入口

- 客户端：`bridges/terra/protected.mjs` 的 `createProtectedTerraClient`；CLI：`bridges/terra/cli.mjs`；协议核心：`bridges/terra/client.mjs`。
- 唯一上游：`bridges/sol/broker.mjs` 的 `brokerCall` → 已安装的 Windows 凭据代理。代理只接受 `{op:'status'}` 与 `{op:'response',body}`；不得改用其它 URL、环境密钥、ChatGPT 登录或代理。
- 模型：`gpt-6.1-terra`；档位：`reasoning.effort=max`。工具：`confirm_terra_api`、`terra_action`、`finish_terra`。
- 生产工厂只接受 `actions`、`allowWrite`、`limits`。`actions` 是项目预先注册的有限动作；模型只选择动作名，不能传路径、命令、脚本或插件。动作 callback 无参数、至多执行一次，本地结果才是证据；`allowWrite` 默认关闭。
- `terra_action` 不是通用 CUA、桌面或图像驱动。本仓库现有的只读验收动作是 `inspect_contract`，不是主机操作或图像工具。项目没有注册对应动作时，主机操作/验收或图像任务报告不可用，不伪造动作。

## 就绪、同意与证据

- 先运行只读 `status`（不计费）。只有同时满足 `ready:true`、`terra_enabled:true`、`terra_model:gpt-6.1-terra`、`terra_reasoning_effort:max`，且 `terra_tools` 含上述三个工具时，才允许发送 Responses。
- `verify-api` 和 `acceptance` 必须带显式 `--accept-terra-charges`；普通实际任务也需用户明确的计费授权。未就绪或未授权时不得发送付费请求。
- status 只证明本机 broker 当时状态；`verify-api` 只证明一次 `confirm_terra_api` 请求；`acceptance` 只证明固定、有界的只读动作。只有真实 response ID、返回模型、usage 和动作回执可作为成功证据，三者不能互相替代。
- 不得回退订阅、ChatGPT 登录或环境密钥，不自动启动服务、不重试未知结果。失败按 `known`/`usage_unknown`/`request_sent` 报告，不编造零用量或成功。

## 共享配额与显式升级

Sol、Terra 和 Luna API 共用同一 Windows 项目、broker 和每小时配额。新装策略写入 `requests_per_hour: 100`，缺少该字段的旧策略仍按 24。已有显式值保留，高于 100 的值不降低。提高配额需要用户授权和显式执行受保护升级。升级保留 `rate.bin` 和审计记录。

```powershell
$setup = Join-Path $sourceRoot 'scripts\setup-sol.ps1'
& $setup -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -RequestsPerHour 100
# 核对预览后：
& $setup -ExpectedRevision '<reviewed-40-char-sha>' -EnableTerraApi -RequestsPerHour 100 -Apply
```

运行中的服务只有在在途调用结束后，才可显式加 `-AllowBriefRestart` 完成一次短维护窗口升级；默认不会停服。升级后用只读 `status` 核对 `requests_per_hour` 为 100，实际计费仍以账单为准。
