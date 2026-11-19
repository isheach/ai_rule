# DSH 同机多实例调度

版本：0.3.0。规则修订：`2026-11-19.dsh-session-controls-r1`。
本文描述的是**同一个 DSH headless/OpenCode Go DeepSeek 后端**的多个本机任务域，不是多套模型、多套凭据或多套操作系统沙箱。
实际调用链由 Astra 和真实 Sol 协调者开始。协调者默认 `gpt-6.2-sol / max`，支持按调用选择。DSH 通过所选 MCP 使用 `opencode-go / deepseek-v4.1-flash`（推理档位 max）。同一 Sol 可在根池内并发多个独立 DSH 任务。
桥接器只是 MCP 进程、任务域和本地子进程的所有者，不替代 Sol，也不新增代理层。

## 1. 为什么按 MCP 服务器划分，而不是按聊天身份自动分流

stdio MCP 进程没有可靠的“聊天 ID”参数。宿主是否向 MCP 注入 `CODEX_THREAD_ID` 或其他线程变量，不是本仓库可以假定的；即使某个版本注入了环境变量，提示词、配置、手填 `caller` 字段也不能当作身份认证。
因此本功能**不实现**根据聊天自动切换实例，也不读取未经验证的线程变量。可靠的做法是：

- 在 Codex 配置中注册多个**命名 MCP 服务**；每个服务是独立桥接进程、独立 runtime、独立锁和任务域。
- 一个 Sol 可按用户要求把不同独立任务分配给不同已注册实例。每个任务固定其服务，原实例负责重试、续跑、查询、等待和取消。
- 聊天选择是宿主可见的 MCP 服务选择；实例身份由桥接器在 `get_dsh_bridge_status` 中返回，不能由调用参数伪造。

Codex 如何展示多个同名工具由宿主决定。若宿主能按服务器区分工具（通常会在工具列表/调用记录中显示服务器名），按上述方式即可；若宿主无法区分，则必须使用宿主支持的服务器作用域或独立 Codex profile，或者不要在同一个宿主上下文中同时启用无法区分的实例。本仓库不会用提示词或自造字段假装实现自动逐聊天隔离。

## 2. 命名、路径和身份规则

| 项目 | 默认实例（兼容 v0.2.0） | 命名实例 |
|---|---|---|
| MCP 服务名 | `dsh-opencode-go` | `dsh-opencode-go-<name>` |
| 实例名 | `default`（隐式） | `<name>` |
| runtime | `%LOCALAPPDATA%\ai_rule\dsh` | `%LOCALAPPDATA%\ai_rule\dsh-instances\<name>` |
| 旧回执/旧幂等数据 | 原位置保留、可读 | 新建，不复制旧数据 |
| 锁 | 该 runtime 的 `active.lock` | 该 runtime 的 `active.lock` |
| 任务回执 | 该 runtime 下 `<task-id>\RUN_RECEIPT.json` | 同左，但域不同 |
| 会话所有权 | 该 runtime 的 `sessions.json`，可回填旧回执 | 仅该 runtime 的 `sessions.json` |

实例名规则（安装器和桥接器共同执行）：

- 只允许小写 ASCII：`[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?`；不允许大写、空格、下划线、点、路径分隔符或尾部点/空格。
- `default` 保留给原服务，不能作为命名实例。
- `con`、`prn`、`aux`、`nul`、`com1..9`、`lpt1..9` 等 Windows 设备名拒绝。
- 每个 runtime 写入 `instance.json`（`schema`、`instance`、`runtime`、版本）。若同一物理路径已属于另一个实例，启动直接失败。Windows 的盘符大小写、斜杠、`.`、`..`、junction/symlink 或短路径别名会先经 `realpath` + 大小写归一化比较，不能靠换写法创建第二个域。
- 不提供“多个实例共用一个 runtime”或“复制旧 runtime 到新实例”的支持。复制数据会触发所有权冲突，应改为在新实例中重新开始任务。

每个实例在状态中至少返回：`instance`、`mcp_server_name`、`runtime`、`bridge_pid`、`bridge_version`、`active_task_id`、`lock_owner`、`schedule`。这些是诊断身份，不是认证凭据。

## 3. 安装多个实例

在仓库目录中，先确认没有正在运行的 DSH 任务，再预览：

```powershell
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop

# 预览：默认服务 + alpha + bravo；不写文件、不调用付费模型
.\scripts\install.ps1 -EnableDsh -DshInstance alpha,bravo

# 核对后安装。新 DSH 实例默认工作区可写。
.\scripts\install.ps1 -Apply -EnableDsh -DshInstance alpha,bravo

# 检查注册与规则
.\scripts\install.ps1 -Verify
```

等价的 Node 命令（可重复传入 `--dsh-instance`）：

```powershell
node .\scripts\manage.mjs --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --apply --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --verify
```

说明：

- 安装器保留已有默认、WorkBuddy、HY4 和无关服务。只新增命名实例时保留默认服务的 runtime、显式权限和日历。新命名实例默认工作区可写，并继承相同的日历配置。
- 若要改默认服务本身（例如切换 runtime、关闭写入或改峰谷策略），先在没有活动任务时运行不带 `--dsh-instance` 的 `--enable-dsh` 命令；在已有默认服务上新增实例时夹带 `--offpeak-schedule`/`--disable-offpeak-schedule` 会被拒绝，避免一次“只加实例”的操作静默替换旧策略。启用日程后再添加实例，会继承已启用的策略。
- 可通过 `--read-only` 将本次创建或重建的服务设为只读。已有的显式只读设置在重建该服务时保留，`--allow-write` 可恢复工作区可写预设。
- `--verify` 只验证 ai_rule managed 块内的注册；未管理的同名/手工服务会列在 `unmanaged_dsh_services` 中，保留但不验证。若新命名服务与未管理服务同名，安装器给出 `Unmanaged MCP ... already exists` 并停止。
- 删除一个命名实例的注册（不删除其 runtime 数据）：

```powershell
node .\scripts\manage.mjs --remove-dsh-instance bravo
node .\scripts\manage.mjs --apply --remove-dsh-instance bravo
node .\scripts\manage.mjs --verify
```

删除只接受由 ai_rule managed 块管理、且真实存在的命名服务；不会动同名的非 managed 服务。要重新加回，用 `--enable-dsh` 和相应实例名。回执、锁和会话索引保留在原 runtime，便于人工核对；确认不再需要后由用户自行处理，不在安装器中自动删除。

新增/修复注册时如遇到 `Unmanaged MCP ... already exists`，说明同名服务不是 ai_rule 管理的，安装器拒绝覆盖。先人工合并配置，不要让两个服务争用同一个名称或 runtime。

## 4. 为独立任务选择实例

有可用的根池时，Sol 优先在同一已验证的根会话派发并发任务。使用传统入口时，Sol 根据用户的任务分配调用宿主可区分的服务。先用各服务的 `get_dsh_bridge_status` 核对名字、实例和 runtime。

例如，用户可以要求“本会话使用 DSH。让同一个 Sol 把项目 A 的只读分析派给 `dsh-opencode-go-alpha`，把项目 B 的只读分析派给 `dsh-opencode-go-bravo`，两项并行。”若只注册了一个传统实例，按顺序完成该实例上的任务。

派发时分别记下实例、任务 ID、幂等键、cwd 和原回执。重试复用原幂等键，续跑到原实例并使用同一个 cwd 和真实 session ID。查询、等待与取消回到记录的那个实例。任务一旦受理就保留原实例。

## 5. 同一实例的续做、互斥和断连

- 同一实例同一时间只允许一个 DSH 子进程；多个聊天共用该实例时，后来者会收到 `Exclusive lock exists` 或 `DSH_BUSY`，应等待原任务，而不是重复启动或换键重跑。
- 忙碌和锁冲突都不会触发 HY4 回退。已受理任务留在原实例，等待该任务并检查原锁和回执。
- 不同实例各有自己的锁、任务回执、幂等键域和 `sessions.json`，可以并行运行。
- `start_dsh_task`/`run_dsh_task` 的 `task_id` 只在所属实例有效。用另一个实例 `get`/`wait`/`cancel` 会得到“not found in DSH instance …”，不会读取或终止别的实例。
- 同一个实例的第二个桥接进程若发现回执属于运行中任务但不拥有其子进程，会返回 `unknown_after_disconnect`。它只能只读查看，不能凭回执取消、杀进程或重新提交。先检查 `active.lock` 的 owner PID、任务回执和原宿主进程，再决定。
- 幂等键是实例内作用域：相同键 + 完全相同参数返回原任务；参数变化拒绝。相同键在另一实例中可以创建不同任务，这是预期的域隔离，不是跨域幂等。
- 继续 DSH 会话必须同时满足：同一实例、同一 cwd、`session_id` 来自该实例自己的回执或 `sessions.json`。新任务由 DSH 生成新的 UUID；不要伪造、复用其他实例的 ID，也不要把旧实例的 runtime 目录复制到新实例。
- 旧默认实例的 v0.2.0 回执没有 `instance` 字段，只允许默认实例读取；首次需要恢复旧会话时可从该 runtime 的旧回执回填 `sessions.json`。命名实例拒绝这种无所有权回执，避免把 legacy 数据误认为自己的会话。
- 断连/超时只改变你看到的连接状态，不等于任务已停止。保留原 task_id、MCP 进程和锁；确认原任务终态后再验收或提交后续任务。

## 6. 峰谷、预算、硬停工和写入边界

每个实例都从自己的 MCP 启动参数读取同一个 `--schedule-config`（如果本机启用了）。启动器会：

- 在峰时和提前 10 分钟门禁拒绝新任务；
- 拒绝 `timeoutMs + 60 秒安全余量` 可能越过下个峰时的任务；
- 在运行中每 15 秒内检查日程，到达峰时只终止**该实例自己拥有的** DSH 子进程树，记录 `schedule_stopped` / `stop_reason=scheduled_peak`；
- 固定 `resume_automatically=false`，不自动恢复、不换模型、不把停止任务标成成功。

新增实例会自动继承已启用的日程参数；安装器不提供“仅对新实例关闭日程”的选项。任何手工改配置以绕过峰谷门禁的行为都不在支持范围内。
正常 DSH 任务默认使用 `workspace-write`。显式 `permissionMode: "read-only"` 限制该任务，`--read-only` 限制该服务。实际写入受任务授权和宿主工作区边界约束。实例共用账户、配额和宿主权限。

## 7. 同步到另一台电脑

Git 只同步代码、规则、Skill、安装器和文档；不同步 Codex `config.toml`、runtime 回执、锁、真实会话、凭据或正在运行的任务。第二台电脑必须自己安装并验证。

在电脑 B 上，按仓库是否已存在二选一：

```powershell
# 已有仓库：只做快进同步
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
git pull --ff-only
```

```powershell
# 首次：先克隆；刚克隆出的仓库不需要再 pull
git clone https://github.com/isheach/ai_rule.git "$env:USERPROFILE\ai_rule"
Set-Location "$env:USERPROFILE\ai_rule" -ErrorAction Stop
```

然后先只更新规则/Skill；确认没有活动任务：

```powershell
node .\scripts\manage.mjs
node .\scripts\manage.mjs --apply
node .\scripts\manage.mjs --verify
```

接下来按电脑 B 是否已有默认 `dsh-opencode-go` 二选一。

**已有默认服务（此用户另一台通常属于这种情况）**：添加命名实例时不要带 `--offpeak-schedule` 或 `--disable-offpeak-schedule`。安装器会保留已有、由 ai_rule 管理的默认注册的 runtime、写入开关和已启用的日程，新实例继承默认服务当前的日程配置（若原本未启用则不新增）：

```powershell
node .\scripts\manage.mjs --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --apply --enable-dsh --dsh-instance alpha --dsh-instance bravo
node .\scripts\manage.mjs --verify
```

默认和命名服务使用注册或内置日历。新会话默认模式 1（无峰谷），模式 2 在峰时把新的独立任务交给 WorkBuddy DSF，模式 3 应用原峰谷。协调者为本会话保存 `scheduleMode` 并随派单传递，用 `set_dsh_task_schedule` 更新本会话仍在运行的 DSH。根池用 `set_pool_schedule` 保存同样的三种模式。旧布尔参数 false/true 对应 1/3。详见 [峰谷调度](offpeak-schedule.md)。

## 8. 验证与排障

安装后执行：

```powershell
node .\scripts\manage.mjs --verify
```

应看到 `dsh_instance_count` 至少为 1，`dsh_instances` 中每个实例的 `identity_valid=true`，`dsh_instances_unique=true`，`dsh_runtimes_unique=true`，`dsh_schedule_consistent=true`，以及启用日程时 `dsh_schedule_config_valid=true`。`dsh_verification_scope` 明确说明这里只验证 ai_rule managed 块；`unmanaged_dsh_services` 中的手工/非 managed 服务只被列出和保留，不参与验证。这只是静态注册检查，不是模型连通性或真实并发验收。

常见错误：

| 现象 | 含义 / 处理 |
|---|---|
| `Runtime ... belongs to DSH instance ...` | 两个实例指向同一物理 runtime；改配置为各自 runtime，不要删 `instance.json` 后共用。 |
| `Exclusive lock exists ...` | 该实例有活动任务或遗留锁；查看 `lock_owner`、回执和进程。不要删除锁后直接重跑。 |
| `Task ... not found in DSH instance ...` | 用错实例或 task_id 不属于该域；回到原实例查询。 |
| `Session ... is bound to cwd ...` / `Unknown sessionId` | 会话只能在原实例、原 cwd 恢复；开新任务，不要伪造或复制会话。 |
| `Unmanaged MCP ... already exists` | 同名服务不是 ai_rule 管理；人工合并，避免重复注册。 |
| `dsh_runtimes_unique=false` | 配置里有共享 runtime 或路径别名；先修配置。 |
| `dsh_schedule_consistent=false` | 实例的显式日历注册参数不同。核对安装器预览与配置。 |

## 9. 验收层级和明确限制

- **静态**：源码/配置解析、实例命名与路径规则、安装预览和 `--verify`。不等于已加载。
- **mock 回归**：`npm test` 使用 `tests/mock-dsh.mjs`，不访问付费 API；覆盖并行子进程、实例锁、幂等域、错误域、旧默认数据、日程/预算/硬停和安装器保留。测试运行环境与原安装隔离。它是独立层级，两次模拟任务也不能拼成“真实双跑”。
- **本机部署**：只有用户在本机运行安装器、按宿主支持的方式加载注册，并由真实 Sol 实际读取新工具状态后才成立；`--verify` 和 MCP 列表本身不够。
- **真实 DSH 并行**。同一 Sol 派发的两个独立任务可分别使用两个命名实例，并核对实际运行时间重叠。记录不同服务名、runtime、task_id、PID、起止时间、原生工具调用和终态。
- 本文不证明服务端真实型号、账单归属、供应商额度或 DSH 凭据隔离；桥接器仍记录 `actual_route=null`，除非另有独立证据。提供商额度另受账户和套餐限制，实例隔离不等于额度隔离。

建议的真实双跑验收（部署后执行，不是本次测试；本次交付不声称已完成）：

1. 由同一真实 Sol 对两个独立任务分别选择 `dsh-opencode-go-alpha` 和 `dsh-opencode-go-bravo`。用各自的 `get_dsh_bridge_status` 核对服务名、实例和 runtime。
2. 在两个互不依赖的项目中各提交一个有用、只读、有界的代码勘察（例如项目 A 的入口与调用链、项目 B 的配置加载与错误路径），让两个真实 DSH 任务实际同时运行。派单明确传入 `permissionMode: "read-only"`。记录双方实际 `task_id`、receipt 中的 `pid`、`started_at`/`finished_at`、`native_tool_calls` 和终态，确认时间区间重叠而非串行，并确认一个实例的 `get` 读不到另一个实例的 ID。不要用空目录、mock 任务或仅聊天问答代替。
3. 用同一传统实例验证串行。先确认该实例空闲，再提交两个测试任务。第二个请求应收到忙碌或锁冲突，等待原任务。
4. 真实并行验收的只读任务显式传 permissionMode 为 read-only，使用获准的项目目录和预算。

这两个真实任务已覆盖连通性，不需要再额外增加无用的付费连通测试；其额度消耗和可用性另受提供商账户/套餐限制。
