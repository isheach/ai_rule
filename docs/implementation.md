# 实现边界与验收

## 本机组件

| 组件 | 运行职责 |
|---|---|
| `bridges/dsh/` | stdio MCP 管理本机 DSH 子进程、回执、锁、预算和日历。调用已安装的 DSH headless。 |
| `bridges/pool/` | 为经宿主证据确认的根会话配置 worker、路由和容量，保留本根会话与任务归属。 |
| `bridges/sol/` | 本机协调 MCP、Responses 工具循环及执行结果验收。由当前根选定 API 协调来源后才提交新的 API 任务。 |
| `bridges/workbuddy/` | 模式 2 交接记录及可选 DSF 项目入口。后者使用锁定的 Tencent Agent SDK 与本机 WorkBuddy 脚本。 |
| `bridges/hy4/` | 按本机 manifest 启动已配置的 CodeBuddy ACP，核实 `hy4free` 目录、权限及任务事件。 |

DSH 通过 stdin 接收任务书。桥核对已安装 CLI 能力、headless 配置与固定路由，保存有限、尽力脱敏的回执。运行状态 `completed` 依据退出码 0 且 `final.reason.kind=completed`。`final.text` 是执行者报告。未独立取证的 `files_changed` 和 `actual_route` 保持 `null`。 [DSH 实现](../bridges/dsh/core.mjs)

## 权限、进程与数据

- DSH 的 `read-only` / `workspace-write` 是其原生权限预设。`--approval-policy never` 拒绝需交互批准的操作。根池另外核验工作目录。结构化文件和命令范围随 DSH 任务书交接，回执以 `scope_handling: task_instructions` 记录这种处理。范围由 DSH 原生权限和指令执行，WorkBuddy 项目入口和 HY4 各自执行结构化范围检查。宿主实际沙箱与账户配置决定进程级边界。
- 活动桥接进程拥有各自的子进程。断开时尽力清理；异常退出后可保留原锁、进程和回执。非所有者可查看已可读的状态，原 PID 或回执本身不授予取消权。Windows 进程树退出结果以本机核对为准。
- 任务 ID、幂等键和会话索引在所属根或实例中使用。终态重放返回原结果。作用域内路径、参数变更和有意修订使用新键。受理不明的请求保留键和已见状态。
- 各执行 Harness 使用自身账号凭据。`sol-coordinator` 从指定的本机环境变量读取 API 密钥，仅用于官方 Responses 请求。下游 DSH 与 WorkBuddy 环境清除相应 OpenAI 凭据。密钥保留在本机环境，任务、报告和交接均须排除。回执、DSH 本机历史和安装备份可能含用户项目或配置细节，留在原机。

## 验收

1. **离线回归**。在仓库根执行 `npm test`。测试使用本机 fixture 覆盖并发、受理和重放、权限检查、峰谷时钟、取消和断连、安装与回滚、Responses 和下游工具交接。
2. **本机安装**。确认安装预览、应用和 `--verify` 的结构输出，规则应为 `rules_current: true`。再按支持的宿主方式加载，由真实 Sol 确认执行服务的工具可用，核对选定的模型、工作目录、权限及实例。配置检查和空闲状态可在实际派发之前完成。
3. **真实调用**。用下一项有用且已批准的任务核对协调者、实际工具发起者、执行者的原生工具结果、退出码或真实终态，以及原回执。DSH 的路由配置、ACP 的目录价和 API Responses 的模型回执分别按实际证据报告。服务端实际计费或额度归属以账单为准。

既有验收记录包含 Windows 临时标准 stdio 中的同根 DSH 文件任务、两个传统 DSH 实例的并行，以及官方 ACP HY4 的原生读、创建、编辑与一次已授权命令。模式 2 的领取和回填已有离线 stdio fixture 覆盖。各机器的注册、真实宿主调用归属及本机凭据、权限和续跑仍以该机器的验收结果为准。 [根池验证](root-pool.md#验证) · [HY4 验证](codebuddy-acp.md#验证)

实现参考见 [DSH Headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)、[MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) 和 [Codex AGENTS 配置](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。
