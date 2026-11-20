# DSH 同机多实例

用默认与命名 MCP 服务建立各自的本机任务域。若只需要一个 Sol 在同一根会话并发多个独立任务，可以启用 [DSH 根池](root-pool.md)。 [运行入口选择](../skills/multi-agent-dispatch/references/dsh.md#选择入口)

## 实例与 runtime

| 项目 | 默认实例 | 命名实例 |
|---|---|---|
| MCP 服务 | `dsh-opencode-go` | `dsh-opencode-go-<name>` |
| 实例名 | `default` | `<name>` |
| 默认 runtime | `%LOCALAPPDATA%\ai_rule\dsh` | `%LOCALAPPDATA%\ai_rule\dsh-instances\<name>` |
| 存储 | `instance.json`、`active.lock`、`requests/`、任务 `RUN_RECEIPT.json` 与 `sessions.json` | 相同结构，独立物理 runtime |

名称允许小写 ASCII 字母、数字和内部连字符，规则为 `[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?`。保留 `default` 及 Windows 设备名。runtime 按物理路径及 Windows 大小写归一化校验，一个物理路径只归属一个实例。默认实例可在原位置读取旧 `v0.2.0` 回执。新命名实例使用自己的运行目录。

宿主负责区分注册中的服务。若多个服务的同名工具无法按注册归属区分，使用宿主支持的服务器作用域或独立 profile。`get_dsh_bridge_status` 返回实例、服务名、runtime、当前状态及锁诊断。每个实例一次运行一个子进程，多个实例共享当前账户、DSH 凭据、额度和宿主权限。

## 安装和移除

在实际仓库目录预览，待受影响的活动任务结束后应用。

```powershell
.\scripts\install.ps1 -EnableDsh -DshInstance alpha,bravo
.\scripts\install.ps1 -Apply -EnableDsh -DshInstance alpha,bravo
.\scripts\install.ps1 -Verify
```

Node 等价命令可重复传 `--dsh-instance`。

```powershell
node .\scripts\manage.mjs --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --apply --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --verify
```

- 已存在默认服务时，上述命令保留其 runtime、只读设定和日历。新实例采用 DSH 工作区可写预设，继承已有默认服务的日历。创建或重建实例时可显式指定 `--read-only`。已有服务的只读设置在重建时保留，`--allow-write` 可恢复可写预设。
- 修改默认服务的日历时，先用单独的 `--enable-dsh` 命令操作默认服务，再新增实例。默认服务已存在时，新增命名实例与改变日历参数的组合会被拒绝。每个会话的峰谷值仍由该会话提交时决定。 [峰谷调度](offpeak-schedule.md)
- `--verify` 结构检查覆盖托管注册块。手工注册列在 `unmanaged_dsh_services`。发现未托管的同名服务时，检查已有条目并本机合并。
- 移除命名实例仅删除存在的托管注册。再次添加时使用同名参数与原 runtime。

```powershell
node .\scripts\manage.mjs --remove-dsh-instance bravo
node .\scripts\manage.mjs --apply --remove-dsh-instance bravo
node .\scripts\manage.mjs --verify
```

另一台电脑按 [README 安装流程](../README.md#windows-安装) 准备 DSH 后，可按需要选择相同或不同的命名实例。每台电脑有自己的凭据、连接和运行数据。

## 验证和排障

在注册按宿主支持的方式加载后，由同一个 Sol 对两个独立的已批准任务分别调用 `dsh-opencode-go-alpha` 和 `dsh-opencode-go-bravo`。从实际工具发起者、实例名、任务 ID、PID、起止时间、原生工具记录及终态核对并行区间。任务选择只读勘察时传 `permissionMode: "read-only"`。

| 现象 | 处理 |
|---|---|
| `Runtime ... belongs to DSH instance ...` 或 `dsh_runtimes_unique=false` | 查是否共享同一物理路径，为各实例选择原有独立 runtime。 |
| `Exclusive lock exists` 或 `DSH_BUSY` | 检查锁所有者和原任务，沿原实例等待。 |
| `not found in DSH instance` | 用原回执的实际服务和任务 ID 查询。 |
| `Unknown sessionId` 或会话绑定另一 `cwd` | 核对实例自身回执中的会话 ID 及目录。 |
| `unknown_after_disconnect` | 核实原进程、所有者与回执。保留锁和原任务。 |
| `dsh_schedule_consistent=false` | 核对托管实例的日历配置和注册预览。 |

静态检查输出包括 `dsh_instances` 中的 `identity_valid`、`dsh_instances_unique`、`dsh_runtimes_unique`、`dsh_schedule_consistent` 和适用的 `dsh_schedule_config_valid`。真实任务的结果、调用者与接入状态见 [验收步骤](implementation.md#验收)。
