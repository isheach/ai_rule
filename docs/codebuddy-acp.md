# CodeBuddy ACP Hy4 适配器

`bridges/hy4/` 使用本机登录的官方 CodeBuddy Code 中国版，通过 ACP 固定 `hy4free`（官方名称 Hy4）。历史 WorkBuddy MCP `hy4-workbuddy` 仍以其本机注册和能力为准。 [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp) · [ACP 会话配置](https://agentclientprotocol.com/protocol/v1/session-config-options)

## 本机 manifest

复制 [manifest 模板](../config/codebuddy-acp.example.json) 为本机 JSON。填已安装的 Node、实际 CLI entry、已登录的专用配置目录、已批准的 workspace、版本和入口 SHA-256。根据本机已有授权设置 `allow_workspace_read`、`allow_workspace_write` 和 `allow_commands`。命令开关还需要已存在的绝对 `hook_shell_path`，例如本机已有的 Git Bash。

启动使用固定 argv、允许列表环境和物理 cwd。命令钩子只在本机启用且本次有逐条批准命令时使用。其余任务通过 `--tools` 选择本轮内置工具，使用严格空 MCP 配置和 `--no-session-persistence`。CLI 版本、入口哈希和本机目录均由适配器检查。账号与凭据保留在已核实的 CodeBuddy 配置目录。

## 本机注册

根池使用 `hy4_manifest` 与 `fallback_authorization_ref` 配置已明确授权的预准入路线。 [根池部署](root-pool.md) · [回退授权](hy4-fallback.md)

也可通过宿主支持的流程单独注册 `bridges/hy4/server.mjs`。给实际服务传下列参数，使用不同的 HY4、DSH 和路由 runtime。

```text
node bridges/hy4/server.mjs
  --hy4-manifest <local-manifest.json>
  --runtime <separate-hy4-runtime>
  --dsh-entry <installed DSH js entry>
  --dsh-runtime <separate-dsh-runtime>
  --routing-runtime <separate-routing-runtime>
  --schedule-config <explicit local schedule.json>
  [--fallback-authorization <non-secret-local-approval-ref>]
```

独立官方入口的 `start/run/get/wait/cancel_hy4_task` 用于显式 HY4。`start/run_routed_task` 使用配置的 DSH 日历及批准的路由，缺少 `--schedule-config` 时拒绝提交。`get_routed_decision` 和 `get/wait/cancel_routed_task` 按原键访问决定和执行回执。`get_hy4_bridge_status` 可读取 readiness、可用能力与回退设置。实际调度参数见 [HY4 操作参考](../skills/multi-agent-dispatch/references/hy4.md)。

## 接入契约

- 使用 ACP `initialize` 协议版本 1，`session/new` 传 canonical cwd 和空的 `mcpServers`。每项任务使用新的 ACP session。每次握手要求当前模型目录明确列出 `hy4free` 的 `x0.00 credits`，若模型列表与 config options 均返回则两者都需通过。`session/set_config_option` 必须回执 `currentValue: "hy4free"`。目录价格缺失或非零时返回 `HY4_FREE_CATALOG_UNVERIFIED`，保持当前选定入口。目录仅用于当次准入，额度与账单取实际账号记录。
- `session/prompt` 是受理边界。发送前持久化 claim 及 `accepted/sending` 记录。此后未知状态通过原键恢复，跟踪原任务，不重复发 prompt。可取消本适配器实际拥有的子进程。
- 文本模式设置空工具列表。只读模式启用 `Read,Glob,Grep` 及 `dontAsk`。工作区写模式额外启用 `Edit,Write` 和 `default` 权限回调。file/terminal client 请求及未知 ACP client method 受适配器限制。工具路径通过 canonical 范围与受保护路径规则检查。
- 目录 scope 的 `create` 对应新增，`replace` 对应覆盖已有内容，`edit` 对应定点编辑。精确文件条目的 `write` 可新增或整体替换，`create` 与 `edit` 按实际文件存在状态核对。目录和精确范围可并用，同一目标的精确条目优先。`content_sha256` 可用于完整写内容的前后哈希校验，编辑无需预计算内容。
- 每次批准的写权限回调核对当前 `sessionId`、之前的 `tool_call`、kind、location 和原生 `rawInput`，选择实际 `allow_once` 的 option。用相应完成事件确认实际操作。拒绝且已有成功操作时保留 `partial`，未收到应有完成事件时记录失败。
- 任务 cwd、文件和范围要求物理路径。路径规则覆盖 symlink/junction、ADS、设备名、UNC、敏感目录及凭据。厂商的读工具拒绝规则和接收事件的路径检查均参与适配器的行为约束。
- 命令默认关闭。启用时要求本机 manifest、hook 和每条 literal 命令的任务授权。厂商默认模式可能自动批准某些安全命令，需分别核对实际 hook、工具事件、权限回调及 OS 环境。

## 验证

既有 Windows 临时标准 stdio 记录使用官方 CodeBuddy Code 2.184.0 和本机既有中国账号。记录中有纯文本、真实 Read、目录范围内自主 create、精确 Edit 及一次逐条授权的 PowerShell 命令。最后的只读回执含 `free_catalog_verified`。对应离线覆盖在 `tests/hy4.test.mjs`、`tests/hy4-native.test.mjs` 和 `tests/pool-mcp.test.mjs`。实际部署在每台机器核对已加载入口、模型目录、批准的能力、工具结果和终态。 [验收层级](implementation.md#验收)
