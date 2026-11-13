# 保留已有 WorkBuddy 桥接器

本仓库不重建用户的定制 WorkBuddy `server.mjs`：目前只有部分代码片段，不能安全重现其授权 profile、实验 runner 及监守扩展。安装器默认保留 `hy4-workbuddy` 与 `deepseek-v4-flash-workbuddy` 的现有配置。

第二台电脑如已有完整桥接器，可执行：

```powershell
.\scripts\install.ps1 -WorkBuddyBridge "D:\实际位置\完整桥接器\server.mjs"
.\scripts\install.ps1 -Apply -WorkBuddyBridge "D:\实际位置\完整桥接器\server.mjs"
```

只有缺少的 MCP 条目才会添加，已存在的同名条目不覆盖。`WB_MODEL` 分别设置为 `hy4-preview` / `deepseek-v4-flash`；脚本必须确实读取该变量。所有伴随模块、策略配置、依赖和本机认证须先齐备。只复制 `server.mjs` 并不足够。本安装器不会调用 WorkBuddy、提交研究任务或验证长任务监守；需在本机分别调用状态工具及一次批准的测试。不要上传凭据、研究数据、私人日志或未经审核的整个旧工作目录。

## 2026-11-13 HY4 入口核查（历史 2.165 证据 + 新 2.184 ACP）

**Phase 2 更新**：用户已授权下载并登录官方 CodeBuddy Code 2.184.0。独立安装、tarball SHA-256 `882f681a…dc9b7`、entry SHA-256 `94e1ff12…857853`；ACP `initialize`/`session/new` 返回 `hy4free`（官方名 Hy4）与 `hy4std`，权限 `dontAsk`；`session/set_config_option` 确认 `hy4free`。一次工具关闭的 smoke 返回 `HY4_OK`，但无 provider model/usage 字段。由此新增**可选、未注册**的 ACP 适配器 `bridges/hy4/`，固定 `hy4free`/`dontAsk`/无工具，不使用 WorkBuddy 桌面内部协议或 GUI token。详见 `docs/codebuddy-acp.md`。

以下 2.165/桌面证据仅保留为历史；它不再代表当前 ACP 入口：

- WorkBuddy 桌面 5.9.3：`D:\WorkBuddy\WorkBuddy.exe`。
- 捆绑 CodeBuddy 2.165.0：`D:\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy`。
- 在 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 下可打印 CLI help；静态 `--model` 列表**不含** `hy4-preview`；help 提及 `--permission-mode` 的 TUI、serve、ACP。
- 一次无 prompt、工具禁用、严格空 MCP 配置、`dontAsk`、隔离配置的 2.165 ACP 能力检查没有返回 initialize 响应；`--help` 退出 0 且列出 ACP，但这不证明旧 CLI 可选 Hy4。
- 官方 WorkBuddy PC 本地 assistant API 只接受 `content`/`msg_type`，要求用户 OAuth，没有 model/cwd/permission 参数。
- WorkBuddy 明确可能以同系列/系统默认模型替换已退役内置模型；“桌面选择器有 Hy4”不是稳定的可脚本 `hy4-preview` 路由证明。
- 本仓库没有完整的旧 WorkBuddy `server.mjs`；已安装的 `hy4-workbuddy` 是否真实可用仍未验证。
- 未读取 `models.json`、auth/config 凭据存储，未提取 GUI token，未修改任何 WorkBuddy/CodeBuddy 注册或配置。

**当前结论**：官方 2.184 ACP 已有真实 `hy4free` 入口；本仓库的适配器与 MCP endpoint 已实现但**未注册、未部署、未在本环境运行**。配置模型不等于 provider/账单证明；CodeBuddy/WorkBuddy 共享中国账号 credits，不声明免费。

**支持范围内的下一步**：用本地 manifest 在人工授权下做一次无 prompt readiness，再按 `docs/codebuddy-acp.md` 决定是否注册新 endpoint。文件读写能力未验证，保持 fail-closed；不得用 `hy4std`、auto、default、其他账号、GUI token 或 prompt 约定冒充已验证能力。

**遗留桥接交接条件**：若走既有 `hy4-workbuddy` 桥接，必须提供完整、经审核的 `server.mjs` 及全部依赖/profile、厂商支持的显式模型选择、fail-closed 窄权限模式、readiness 和获授权的隔离只读/写入验证。只凭登录、桌面 UI 或 Open API OAuth 不能证明 HY4 可用。
