# CodeBuddy ACP → Hy4 适配器（可选；临时 stdio 已验证，未每机注册/部署）

状态：**Windows 临时标准 stdio 已由真实 Sol 实际验证；每台机器的 MCP 注册/宿主加载仍未声明。** 实际使用本机已安装官方 CodeBuddy Code `@tencent-ai/codebuddy-code` 2.184.0、同一 WorkBuddy 中国账号，固定模型 `hy4free`（官方名称 Hy4）。这不是 WorkBuddy 桌面 RPC，也不使用 GUI token。参考：[CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp)、[CLI reference](https://www.codebuddy.cn/docs/cli/cli-reference)、[ACP session config](https://agentclientprotocol.com/protocol/v1/session-config-options)、[ACP file system](https://agentclientprotocol.com/protocol/v1/file-system)。

已验证：真实 HY4 native 文件任务 `562f7540-1ccb-4dea-96e8-84989656cc48` completed/end_turn（两次读、一次 create、一次精确 Edit）；一次显式授权的无害 PowerShell 任务 `07ee1a25-76cb-422a-b0b8-9f49d82d116b` completed，vendor 默认 auto-allow，独立核对文件未变；最终价格 guard native Read 任务 `1f0d3538-de2c-48f8-91e2-4f6b6994327d` completed/end_turn，receipt `free_catalog_verified`。统一 MCP 回退另以隔离 DSH 预准入拒绝触发，DSH 零模型请求。均为临时 stdio，不是每机已注册。

## 1. 已实现的真实协议边界

固定 argv（无用户追加参数）：

```text
<node> <cli-entry> --acp --tools "<capability tools>" --strict-mcp-config
  --mcp-config {"mcpServers":{}}
  --setting-sources user --permission-mode <dontAsk|default>
  --settings {"disableAllHooks":true,"permissions":{"deny":[...]}} --no-session-persistence
```

`text-only` 的 tools 为空且 permission `dontAsk`；`workspace-read` 为 `Read,Glob,Grep` + `dontAsk`；`workspace-write` 为 `Read,Glob,Grep,Edit,Write` + `default` 回调。`--settings` 里的 `permissions.deny` 使用 CodeBuddy 文档的 `Read(...)` 路径模式；命令 hook 只在命令能力显式启用时改变 settings/setting-sources。实际一次授权 PowerShell 命令由 vendor 默认 auto-allow，不能据此声称所有命令都必须经过 ACP permission callback。

- `shell:false`；child cwd 必须位于 manifest 的 `workspace_root` 内并 realpath 规范化。
- 子进程 env 只保留 Windows 系统/profile 定位变量（`SystemRoot/WINDIR/PATH/ComSpec/PATHEXT/TEMP/TMP/USERPROFILE/APPDATA/LOCALAPPDATA`），加固定的 `CODEBUDDY_CONFIG_DIR`、`CODEBUDDY_INTERNET_ENVIRONMENT=internal`、`DISABLE_AUTOUPDATER=1`、`CODEBUDDY_DISABLE_AUTO_MEMORY=1`、`CODEBUDDY_DISABLE_PARENT_MEMORY=1`；不继承 auth/token/cookie 变量，manifest 不提供任意 env/URL/hooks。
- 启动前校验 entry SHA-256 与 `--version`；不匹配即 fail-closed。
- `initialize` 使用 `protocolVersion:1`、`clientCapabilities:{}`；`session/new` 使用真实 cwd 与 `mcpServers:[]`。
- 要求 ACP 权限模式匹配能力；当前 catalog 必须包含 hy4free 且明示 `x0.00 credits`（`session.models.availableModels` 和/或 configOptions，两者都给出时必须都为零），随后 `session/set_config_option` 必须确认 `currentValue === "hy4free"`。绝不回退 `hy4std`、auto、default、其他账号或其他 vendor；目录价是准入证据，不是账单/provider attestation。
- `session/prompt` 是**受理边界**。发送前已持久化 claim + `accepted/sending` receipt；发送后断连/半包/超时只能是 `unknown`，同一幂等键不再重发。
- 无工具模式：拒绝 agent 的 `fs/*`、terminal 和其他未知 client method；`session/request_permission` 返回 cancelled；出现任何 `tool_call` 事件即失败关闭。不会把 CLI 内置工具当成已隔离能力。
- 输出/超时/进程生命周期有界；仅终止本适配器拥有的 child，不按 PID 文件杀进程；不持久化 stderr、transcript、prompt、token 或原始协议日志。
- receipt 只保存 task/request ID、幂等哈希、prompt SHA-256、cwd、模型/权限、状态、stop reason、sanitized answer、tool event 数和安全错误码。用户 prompt 不落盘。

## 2. 本地 manifest（不写入仓库的机器值）

复制 `config/codebuddy-acp.example.json` 到仓库外或未跟踪的本地文件，填入本机 Node、隔离安装的 CLI entry、专用已登录 `CODEBUDDY_CONFIG_DIR`、批准 workspace root、版本与 SHA-256。示例中的路径是占位符；本仓库不硬编码本机 Node/entry/config 路径，也不读取凭据。

```json
{
  "schema": 1,
  "node_path": "C:\\path\\to\\node.exe",
  "cli_entry": "C:\\path\\to\\...\\cli.js",
  "config_dir": "C:\\path\\to\\dedicated-signed-in-config",
  "workspace_root": "D:\\path\\to\\approved\\workspace",
  "expected_version": "2.184.0",
  "expected_entry_sha256": "94e1ff...",
  "expected_tarball_sha256": "882f68...",
  "internet_environment": "internal",
  "allow_workspace_read": false,
  "allow_workspace_write": false,
  "allow_commands": false
}
```

`allow_commands:true` 还要求显式 `hook_shell_path`（例如已存在的 `C:\\Program Files\\Git\\bin\\bash.exe`）；本阶段保持 false，且不安装 Git、不改 PATH。

Manifest has no free-form `env`; the adapter supplies a fixed allowlisted child environment and fixed flags. Auto/parent memory and hooks are disabled by adapter flags/env.

## 3. 可选 MCP endpoint（临时 stdio 已验证，未每机注册/部署）

```text
node bridges/hy4/server.mjs
  --hy4-manifest <local-manifest.json>
  --runtime <separate-hy4-runtime>
  --dsh-entry <installed DSH js entry>
  --dsh-runtime <separate-dsh-runtime>
  --routing-runtime <separate-routing-runtime>
  --schedule-config <explicit local schedule.json>       # required for start/run_routed_task
  [--fallback-authorization <non-secret-local-approval-ref>]
```

- 默认只读；三个能力必须显式选择，不能把普通 read-only 任务静默升级：
  - `text-only`：`--tools ""`，无文件/命令工具。
  - `workspace-read`：`Read,Glob,Grep`，`dontAsk`；只允许 canonical task cwd 内，供应商 `Read` deny 规则覆盖敏感路径。
  - `workspace-write`：`Read,Glob,Grep,Edit,Write`，`default` 权限回调；需要 manifest `allow_workspace_write`、`permissionMode:"workspace-write"`、`cwd`、非秘密 `authorizationNote`，以及 `writeScopes` 和/或 `writes`。
- `writeScopes` 是 canonical cwd 内已存在目录的数组，元素 `{path, operations}`；`operations` 是 `create`/`replace`/`edit` 的子集。`writes` 是精确文件数组，元素 `{path, mode:'create'|'edit'|'write', content_sha256?}`；不要求预先生成内容。
  - 写入按 native 结果分类：目标不存在 + full `Write` = `create`；目标存在 + full `Write` = `replace`；`Edit` 目标存在 = `edit`。
  - `write` 的精确授权同时允许 absent-create 和 present-replace；`create` 只允许不存在；`edit` 只允许已存在。`Edit` 创建 absent 文件必须另有 `writeScopes` 的 `create` 操作，否则拒绝。
  - `content_sha256` 只适用于 full-content `create`/`write`，对 `edit` 拒绝；提供时按 HY4 raw `content` 校验，并在完成后核对目标文件哈希。无哈希是正常路径。
  - 精确文件授权与目录 scope 相加；同一路径有 exact 条目时，以 exact mode/hash 为准，不能被更宽 scope 绕过。
- 每次 write 权限回调必须满足：`sessionId` 与已建立 session 相同、`toolCallId` 对应先前 `tool_call`、先前事件有 `kind:edit`、locations 精确匹配目标、`rawInput` 的 `file_path/path` 与 `content` 或 `old_string/new_string/replace_all` 一致、存在 `allow_once` 并返回其真实 `optionId`。绝不选 `allow_always`，不从模型文字推断批准。许可按 `toolCallId` 一次，不按文件一次；同一文件后续新 toolCall 仍可在 scope 内批准。
- `_mergeToolEvent` 保留初始 kind/locations 并在 update 缺失 kind 时沿用；status 迁移单独记录 `completed_operations`。允许但未收到完成 status 的任务是 `failed`/`HY4_OPERATION_NOT_CONFIRMED`，不是成功。已完成的允许写入算完成；被拒绝的 scope/敏感/越界路径计入 denied，若之前有成功写入则终态 `partial`，否则 `refused`。
- `file://` location 用 `fileURLToPath`；拒绝 ADS、device、UNC、短名、尾点/空格、symlink/junction、`.git`、`.env*`（含合成 `.env.fixture`）和凭据目录/文件。拒绝发生在 canonical 化之后，也检查 canonical 结果是否变成受保护路径。这是任务权限契约，不是 OS 沙箱或完整机器隔离证明。
- `commands` 字段、`allow_commands` manifest 开关和 PreToolUse hook 源码保留但默认禁用；启用需本地 manifest 和每条 literal 命令的逐任务授权。临时 pooled MCP 中一次显式授权的无害 native PowerShell 命令已完成，vendor 默认 auto-allow；不声称所有命令都经 ACP permission callback，也不声称 OS 隔离。
- Routed DSH calls are refused when `--schedule-config` is omitted; the new endpoint must not bypass peak.

- 不提供/不改写默认 `dsh-opencode-go`、`alpha`、`bravo`、`godot`、`hy4-workbuddy` 或 DSF 注册；需另行人工评估后注册。
- 工具：`get_hy4_bridge_status`、`start/run/get/wait/cancel_hy4_task`、`start/run_routed_task`、`get_routed_decision`、`cancel_routed_task`。
- `start/run_hy4_task` 是显式 HY4，只走 ACP hy4free，不回退 DSH。`start(input)` 也接受既有 `input.capability`；显式第二参数与字段冲突时拒绝，二者都缺省仍为 `text-only`。
- `start/run_routed_task` 走 DSH 主后端；只有 `RoutingCoordinator` 的结构化预准入日程门禁 + 显式 `--fallback-authorization` + HY4 ready + 兼容能力时才转 HY4。busy/lock/权限/session 继续/修复/unknown/超时/停止均不回退。
- `--fallback-authorization` 缺失时回退默认关闭。
- HY4/DSH/routing 的 runtime 必须物理分离；相同路径启动直接失败。每次 `_open` 的 handshake 必须在 `session/new` 后、prompt 前确认 hy4free 的官方 catalog entry 明确标为 `x0.00 credits`；缺失或非零返回 `HY4_FREE_CATALOG_UNVERIFIED`，这只是价格目录证据，不是账单 attestation。

## 4. 安全能力与限制

| 能力 | 状态 |
|---|---|
| 无工具文本问答 | 已实现；`text-only` + `read-only` |
| workspace-read（Read/Glob/Grep） | 已接入；需 manifest `allow_workspace_read`；临时统一 MCP 中真实 native Read 已验证，mock 覆盖越界/`.env.fixture`；未声明每机已注册 |
| workspace-write（Edit/Write） | 已接入；需 manifest `allow_workspace_write` + 每任务 cwd/`authorizationNote` + `writeScopes`/`writes`；临时统一 MCP 已验证批准目录下一次自主 create 和一次精确 Edit，mock 覆盖 create/edit/replace、无哈希、scope、symlink/ADS/敏感拒绝和混合终态；未声明每机已注册 |
| 普通 read-only/file 任务 | 不得静默降级/视为 HY4 兼容 |
| CLI 内置工具 | text-only 固定 `--tools ""`；出现 tool event 即失败 |
| ACP 文件/终端/未知 client method | 拒绝；permission 仅 `allow_once` |
| 符号链接/junction 逃逸 | root/cwd/scope realpath + containment；逐组件拒绝 symlink/junction |
| Windows ADS/凭据文件名 | 拒绝 `:`、device、UNC、尾点/空格、8.3 别名、敏感名 |
| 模型切换/计费回退 | 固定 hy4free；无 fallback 模型 |
| 取消 | 仅 owned child；无 stale PID kill |
| 命令 | 可选、默认关闭；需本地 manifest + 每条 literal command 显式授权。实际一次无害 PowerShell 已完成并经 vendor 默认 auto-allow；不声称所有命令都经 ACP permission callback，也不声称 OS 隔离 |

workspace 能力已由临时统一 MCP 实际验证 native Read、批准目录 create/Edit；代码/配置不是 OS 沙箱证明。供应商文档说明 Read deny 规则是跨读工具的最佳努力，不是 OS 强制隔离；适配器另外检查 tool_call 路径并 fail closed。

## 5. 账号与计费边界

官方 WorkBuddy Pricing 描述 CodeBuddy 与 WorkBuddy 共享中国账号 credits；本适配器不声明免费，也不提供账单 attestation。`hy4free` 的 x0.00 广告价来自 ACP 目录/用户观察，不等于永久免费或账单证明。当前配置没有 provider usage/model attestation 字段，因此报告只说“configured model = hy4free”，不声称服务端实际计费型号。

## 6. 验证状态

已写入：
- `tests/fake-codebuddy-acp.mjs`：仅本地行 JSON-RPC fixture，无网络/凭据/模型；支持 create/edit/replace、重复同文件不同 toolCallId、scope/敏感/symlink 拒绝、无完成 status、file URI、可选 command fixture。
- `tests/hy4.test.mjs`：probe、pin mismatch、permission mismatch、auth gate、denial、partial→unknown、no duplicate、cancel、tool-event fail-closed、workspace/permission 边界、coordinator fallback、显式 HY4、MCP endpoint。
- `tests/hy4-native.test.mjs`：显式 capability 字段/参数、无 hash create/edit、目录 scope、精确 write absorber、outside/sensitive/ADS/symlink 拒绝、实际完成计数、混合终态、file URI、幂等冲突、旧回执 fail-closed。
- `tests/pool-mcp.test.mjs`：同一 normalized writeScopes 经 pooled MCP 到 HY4 fallback；既有 pool/DSH 回归保留。可选 native command fakes 已启用并通过。

**验证结果**：113/113 isolated mocks 通过，0 skipped，包括 opt-in native command fakes。真实临时统一 MCP 中，native 文件任务 `562f7540-1ccb-4dea-96e8-84989656cc48` completed/end_turn（两次 Read、一次自主 create、一次精确 Edit）；授权无害命令任务 `07ee1a25-76cb-422a-b0b8-9f49d82d116b` completed，vendor 默认 auto-allow，独立核对文件未变；最终免费目录 guard Read 任务 `1f0d3538-de2c-48f8-91e2-4f6b6994327d` completed/end_turn，receipt `free_catalog_verified`。这些是临时 stdio 证据，不等于每机注册/宿主加载或 OS 隔离。

## 7. 使用与 per-machine registration

临时标准 stdio 已验证，但每台机器仍需按 [root-pool.md](root-pool.md) 自行 opt-in 注册 `dsh-root-pool`（node entry + `--config ABS`），保留所有 legacy endpoints、原 schedule 和 `resume_automatically=false`，不自动恢复。没有 pool 的安装继续有效。

只有在没有活动任务时通过宿主支持的 MCP reload 加载，并确认实际工具列表出现 `start/run/get/wait/cancel_pool_task` 与 `get_pool_status` 后，才可以说本机已启用。工具可见后用户说“使用 DSH”或同义选择即选择根池；不需要 root/instance 名。Sol 从已注册 server 旁的 `cli.mjs` 取 context，具体命令见 root-pool 文档。

live 文件/命令验证只在用户批准的隔离合成 scope 执行；保持 `hy4free` pin、价格 guard、只读默认和逐任务授权。目录价不是账单/provider attestation，临时 MCP 通过也不等于每机宿主加载、桌面 app、多聊天 identity、认证或 OS 隔离。
