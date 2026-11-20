# WorkBuddy DSF 桥接器

`deepseek-v4-flash-workbuddy` 可选用本仓库维护的项目入口。一个物理项目根对应一个已批准的本机项目记录。同一项目内换论文、脚本、数据或任务名时，Sol 传新任务和当前 `cwd`，沿用项目授权和已加载的服务。 [安装与验收](../../docs/workbuddy-project-entry.md)

项目入口使用固定版本的 Tencent Agent SDK 和本机 WorkBuddy 安装内已核实的实际脚本。显式锁定 `cli/dist` 下的 `codebuddy-lite-wb.mjs` 或 `codebuddy-headless.js`，沿用现有桥接器实际使用的脚本。在状态检查和派发前核对脚本的 SHA-256，核对目录及执行流中的固定模型 `deepseek-v4-flash`。`get_task_bridge_status` 检查项目和任务权限，`run_workbuddy_task` 同步返回回执，`get_workbuddy_task` 按原幂等键查回执。模式 2 的实际峰时仍由 `dispatch.mjs` 管理一次领取和终态回填。 [峰谷派发](../../docs/offpeak-schedule.md)

订阅 Sol 使用宿主加载的入口。API Sol 可在 `workbuddy.project_config` 指向同一本机项目配置。一次性迁移沿用 MCP 名称 `deepseek-v4-flash-workbuddy`，在原任务完成后只载入变化的入口。安装器支持预览和备份，已有 HY4 和 DSH 注册继续使用原设置。 [API Sol 配置](../../docs/sol-coordinator.md)

## 已有定制入口

安装器默认保留 `hy4-workbuddy` 和 `deepseek-v4-flash-workbuddy` 的原注册。仍采用旧 DSF 桥接的机器，按其实际 schema 使用已获批的 profile。旧桥由其实际 `server.mjs`、伴随模块、权限配置、依赖及本机认证一起提供。私有实现由原工作目录维护。

在已有整套定制桥接器的机器上，可用以下命令添加缺少的旧入口。

```powershell
.\scripts\install.ps1 -WorkBuddyBridge 'D:\实际位置\完整桥接器\server.mjs'
.\scripts\install.ps1 -Apply -WorkBuddyBridge 'D:\实际位置\完整桥接器\server.mjs'
```

旧入口的 `WB_MODEL` 分别为 `hy4-preview` 和 `deepseek-v4-flash`。脚本须实际读取这些值，Sol 按加载的工具和真实结果验收。凭据、研究数据和完整私有日志留在原机器。

## 相关 HY4 核查

2026-11-13 的历史 WorkBuddy 5.9.3 附带 CodeBuddy 2.165.0。该版本的帮助列出 ACP，隔离的无 prompt ACP 检查没有得到 `initialize` 回复。后续独立的 CodeBuddy Code 2.184.0 ACP 会话目录和设模回执确认了 `hy4free`，并完成一个纯文本 smoke。HY4 的文件能力和预准入回退另见当前适配器验收。 [CodeBuddy ACP](../../docs/codebuddy-acp.md) · [HY4 回退](../../docs/hy4-fallback.md)

WorkBuddy DSF 项目入口与 HY4 ACP 适配器分别核验。本机旧 WorkBuddy 2.165.0 对当前 SDK 项目入口的兼容性及实际 DSF 模型调用待本机验收。
