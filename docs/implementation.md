# 实现边界与验收

## 本机组件

| 组件 | 运行职责 |
|---|---|
| `bridges/dsh/` | stdio MCP 管理本机 DSH 子进程、回执、锁、预算和日历。调用已安装的 DSH headless。 |
| `bridges/pool/` | 为经宿主证据确认的根会话配置 worker、路由和容量，保留本根会话与任务归属。 |
| `bridges/sol/` | 本机协调 MCP、Responses 工具循环及执行结果验收。Sol 可按父任务授权调用 Terra 或 Luna，三者共用受保护代理。 |
| `bridges/dispatch/native-peer.mjs` | 订阅 Sol 的宿主适配入口。冻结父任务范围，在同一来源调用实际 Terra 或 Luna 并保存子任务回执。 |
| `bridges/workbuddy/` | 模式 2 交接记录及可选 DSF 项目入口。后者使用锁定的 Tencent Agent SDK 与本机 WorkBuddy 脚本。 |
| `bridges/hy4/` | 按本机 manifest 启动已配置的 CodeBuddy ACP，核实 `hy4free` 目录、权限及任务事件。 |

DSH 通过 stdin 接收任务书。桥核对已安装 CLI 能力、headless 配置与固定路由，保存有限、尽力脱敏的回执。运行状态 `completed` 依据退出码 0 且 `final.reason.kind=completed`。`final.text` 是执行者报告。未独立取证的 `files_changed` 和 `actual_route` 保持 `null`。 [DSH 实现](../bridges/dsh/core.mjs)

## 权限、进程与数据

- DSH 的 `read-only` / `workspace-write` 是其原生权限预设。`--approval-policy never` 拒绝需交互批准的操作。根池另外核验工作目录。结构化文件和命令范围随 DSH 任务书交接，回执以 `scope_handling: task_instructions` 记录这种处理。范围由 DSH 原生权限和指令执行，WorkBuddy 项目入口和 HY4 各自执行结构化范围检查。宿主实际沙箱与账户配置决定进程级边界。
- 活动桥接进程拥有各自的子进程。断开时尽力清理；异常退出后可保留原锁、进程和回执。非所有者可查看已可读的状态，原 PID 或回执本身不授予取消权。Windows 进程树退出结果以本机核对为准。
- 任务 ID、幂等键和会话索引在所属根或实例中使用。终态重放返回原结果。作用域内路径、参数变更和有意修订使用新键。受理不明的请求保留键和已见状态。

### API Sol 凭据路径

| 边界 | 原路径与变更 |
|---|---|
| Windows 源码与安装身份 | `setup-sol.ps1` 检查指定 Git 修订并在普通用户身份下配置 Codex。需要代理操作时，提升步骤校验该提交的安装载荷，在管理员控制的 `Program Files` 临时目录运行服务安装。用户在已安装程序的提升交互提示内录入密钥。 |
| Codex 与订阅 Sol | 订阅走原生宿主。旧注册通过 `env_vars` 向 Sol 转发 API Key。新注册仅转发 `CODEX_HOME` 和已批准的 WorkBuddy 非 OpenAI 变量。旧 JSON 仍可读取已有回执，使用 API 前须迁移。 |
| Sol MCP 与 CLI | 旧 `config.mjs` 读取密钥，旧 `responses.mjs` 在协调器内组装 Bearer 请求。现在两种入口都经受保护的本机客户端发送限定 JSON。付费验证和普通任务共用代理，健康检查仅走本地 IPC。 |
| DSH 与根池 | 原先独立入口的 CLI 探测、配置转储、任务进程及 Windows 终止进程会继承父环境。现在各入口显式过滤 OpenAI 变量和 `CODEX_API_KEY`。OpenCode Go 继续使用自身配置。 |
| WorkBuddy DSF 与 HY4 | Sol 的定制 stdio 连接按白名单建环境，项目 SDK 显式清除白名单外的继承项，HY4 的 ACP、版本探测及命令入口按已有白名单运行。各执行者继续使用自己的账号。 |
| 本地 IPC 与上游 | 代理独立进程在专用 Windows 账户内解密和使用 API Key。普通调用支持状态查询和受限模型请求。用户录入走独立管理通道。原始密钥、请求头、上游原始错误不进入普通响应。 |
| 上下文、任务与日志 | 根上下文引用、幂等键、任务归属及用量回执保留原格式。模型看到获准的任务背景与执行结果，DSF 只收到派发内容。代理审计仅记录调用元数据。协调器和执行器的本机回执可能含用户项目内容，按原规则留在原机。 |

过滤环境变量是迁移保护。隔离取决于专用账户、受保护的程序和存储、对双方身份的验证，以及执行器以普通权限运行。管理员、SYSTEM 或已取得这些权限的程序在信任边界内。同一获准用户下的其他普通进程可以消耗代理配额，不能从请求接口导出密钥。如果要进一步区分调用者与同一桌面用户下的程序，应将协调器或执行器移到独立身份或主机。[部署与迁移](sol-coordinator.md) · [Windows 服务账户与配置文件](https://learn.microsoft.com/windows/win32/services/service-user-accounts) · [Windows 命名管道权限](https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights)

## 验收

1. **源码和离线回归**。核对仓库的绝对路径与实际 Git 修订。在仓库根执行 `npm test` 或使用 `npm --prefix $sourceRoot test`。测试 fixture 覆盖并发、受理和重放、权限检查、峰谷时钟、取消和断连、安装与回滚、Responses 和下游工具交接。
2. **目标机安装**。核实实际 Windows 入口、目标账户与配置路径。确认安装预览、应用和 `--verify` 的结构输出，检查 `rules_current: true` 及所装入口的结构结果。云端工具先完成可执行的源码和离线工作。有目标机操作时，以实际入口的调用结果证明安装及服务状态。
3. **实际宿主就绪**。按所用 Codex 宿主支持的方式加载注册，由真实 Sol 核实执行服务及其模型、工作目录、权限和实例。API Sol 分别记录普通用户的 `broker-status` 和实际会话的 `get_sol_coordinator_mode`。可在实际派发前完成这些检查。
4. **真实调用**。用下一项获准的任务核对协调者、实际工具发起者、执行者的原生工具结果、退出码或真实终态，以及原回执。API Sol 的上游验证需要付费调用授权。DSH 的路由配置、ACP 的目录价和 API Responses 的模型回执分别按实际证据报告。服务端实际计费或额度归属以账单为准。

既有验收记录包含 Windows 临时标准 stdio 中的同根 DSH 文件任务、两个传统 DSH 实例的并行，以及官方 ACP HY4 的原生读、创建、编辑与一次已授权命令。模式 2 的领取和回填已有离线 stdio fixture 覆盖。各机器的注册、真实宿主调用归属及本机凭据、权限和续跑仍以该机器的验收结果为准。 [根池验证](root-pool.md#验证) · [HY4 验证](codebuddy-acp.md#验证)

实现参考见 [DSH Headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)、[MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) 和 [Codex AGENTS 配置](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。
