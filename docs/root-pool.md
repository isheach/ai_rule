# DSH 根会话池

`dsh-root-pool` 是可选 stdio 服务。它用已验证的宿主会话根分配本机 DSH worker，同一 Sol 可并发派发多个独立任务。注册并加载后，“使用 DSH”按 [DSH 入口选择](../skills/multi-agent-dispatch/references/dsh.md#选择入口) 使用根池。显式选择的传统服务仍通过其注册调用。

## 本机配置和注册

1. 复制 [根池模板](../config/root-pool.example.json) 为本机 JSON，替换所有绝对路径。`workspace_root` 是已批准的项目目录。保留实际写入上限，设置 `allow_write: false` 可使服务只读。只有已明确批准 HY4 回退时才同时配置 `hy4_manifest` 和 `fallback_authorization_ref`。 [HY4 授权](hy4-fallback.md)
2. 备份当前 Codex 配置，在现有 MCP 项中添加一份对应本机绝对路径的注册。
3. 待使用相关入口的任务安全结束后，按宿主支持的方式加载。由真实 Sol 验证工具与当前根，读取 `get_pool_status` 的有效状态。

```toml
[mcp_servers.dsh-root-pool]
command = "C:\\Program Files\\nodejs\\node.exe"
args = [
  "C:\\Users\\YOUR_USER\\ai_rule\\bridges\\pool\\server.mjs",
  "--config",
  "C:\\Users\\YOUR_USER\\ai_rule-state\\root-pool.local.json"
]
startup_timeout_sec = 20
tool_timeout_sec = 3700
```

`tool_timeout_sec` 使用实际宿主支持的值。普通 DSH 的可写预设可由任务 `read-only`、配置 `allow_write: false` 或注册 `--read-only` 收窄。相关标准注册满足工作区及权限条件时，API 协调器可使用同一根池。 [API 安装](sol-coordinator.md#windows-安装)

## 根身份与生命周期

Sol 在自己的宿主 shell 从已注册入口获取短期 opaque `context_ref`，客户端用 `context` 传入。辅助程序读取实际 `CODEX_THREAD_ID` 和 rollout 首行 `session_meta`，沿父链核验根，元数据读取上限 256 KiB。根由受支持的宿主标识确认，包括 `source: "vscode"` 或 `originator: "codex_work_desktop"`。遇到缺失、歧义或循环引用时报告校验失败。服务验证引用的文件、期限及重新解析的宿主父链。 [获取上下文](../skills/multi-agent-dispatch/SKILL.md#获取根会话上下文)

上下文默认有效 5 分钟，从原宿主上下文刷新。引用的用途是路由和根绑定。本机同 OS 账户的进程仍处于同一信任边界。公开工具接收 `context` 与本根任务的键或 ID。每个子进程的控制仍取决于原所有者。

| 状态 | 归属与处理 |
|---|---|
| 初次派单 | 延迟建立根绑定，独占预留一个 worker。 |
| 可认定未受理 | 按结构化决定释放预留。模式 2 的 WorkBuddy 预留使用本根交接记录。 |
| 已受理 | 以实际任务、绑定及运行操作为准，查询和取消找原所有者。 |
| 启动中或未知 | 占用容量，保留原 worker，避免重复提交。 |
| 终态重放 | 按本根原键或实际任务映射获取旧回执。 |
| 空闲回收 | 依据实际任务的最后活动时间释放 ordinal，保留根的历史与 runtime。 |

根池全局运行上限 `running_cap` 默认 3，含启动、活跃和未知任务。`binding_cap` 单独限制可绑定根数。`ttl_hours` 默认 24。根的 `dsh/`、`hy4/`、`routing/` 及额外 `workers/<number>/dsh/` 分别留存对应状态。续跑由原实际会话和 cwd 找回 worker。服务内部用 generation、lease 和一次性 operation proof 校验操作。非所有者得到可读快照。

池读取已有 schema 1 和 2 状态，绑定和日程更新写入 schema 3。升级访问同一池的进程前，先使现有活动任务取得终态。旧回执继续在其实际作用域使用。

## 验证

`tests/pool.test.mjs` 覆盖绑定、容量、归属、过期及父链。`tests/pool-mcp.test.mjs` 通过 stdio fixture 覆盖多个合成根、峰谷、WorkBuddy 交接和 HY4 范围。

先前 Windows 临时 stdio 验收中，同一真实根在两个批准的 cwd 完成 DSH 文件任务，取得独立会话和可回读的原键。另有两个真实命名实例的并行结果。独立合成根的并发由 mock stdio 覆盖。各安装环境继续按本机宿主、加载的服务和实际归属验收。 [完整验收](implementation.md#验收)
