# DSH 多实例：同机多个聊天各自使用独立调度域

版本：0.3.0。规则修订：`2026-11-12.dsh-multisession-r1`。
本文描述的是**同一个 DSH headless/OpenCode Go DeepSeek 后端**的多个本机任务域，不是多套模型、多套凭据或多套操作系统沙箱。
真实调用链仍然是：**Astra 主代理 → 真实 GPT-6.1 Sol Max（max）协调子代理 → 所选 DSH MCP 实例 → DSH headless → `opencode-go / deepseek-v4.1-flash`（推理档位 max）**。
桥接器只是 MCP 进程、任务域和本地子进程的所有者，不替代 Sol，也不新增代理层。

## 1. 为什么按 MCP 服务器划分，而不是按聊天身份自动分流

stdio MCP 进程没有可靠的“聊天 ID”参数。宿主是否向 MCP 注入 `CODEX_THREAD_ID` 或其他线程变量，不是本仓库可以假定的；即使某个版本注入了环境变量，提示词、配置、手填 `caller` 字段也不能当作身份认证。
因此本功能**不实现**根据聊天自动切换实例，也不读取未经验证的线程变量。可靠的做法是：

- 在 Codex 配置中注册多个**命名 MCP 服务**；每个服务是独立桥接进程、独立 runtime、独立锁和任务域。
- 每个聊天在会话内明确选定一个服务，并只调用该服务的工具。
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

# 核对后安装；新命名实例默认只读，已有默认服务/设置原样保留
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

- 安装器始终保留默认 `dsh-opencode-go`，并保留已注册的 WorkBuddy、HY4 和无关的非 ai_rule 服务。已有默认服务在“只新增命名实例”时不会被重写：它的 `--runtime`、`--allow-write` 和 `--schedule-config`（含自定义路径）原样保留，因此旧回执、幂等数据和写入能力不会被静默迁移或降级。新命名实例默认只读，并继承默认服务的同一日程配置（含自定义路径）。
- 若要改默认服务本身（例如切换 runtime、关闭写入或改峰谷策略），先在没有活动任务时运行不带 `--dsh-instance` 的 `--enable-dsh` 命令；在已有默认服务上新增实例时夹带 `--offpeak-schedule`/`--disable-offpeak-schedule` 会被拒绝，避免一次“只加实例”的操作静默替换旧策略。启用日程后再添加实例，会继承已启用的策略。
- `--allow-write` 只对本次 `--dsh-instance` 列出的新/重建命名服务生效，不会改写保留下来的默认服务；未列出的已有命名服务也原样保留。添加实例时应查看 `--verify` 输出中的 `allow_write`，不要把“新增一个只读实例”误当成“自动改写了所有旧实例”。它是本机开关，不是实例隔离或永久授权。
- `--verify` 只验证 ai_rule managed 块内的注册；未管理的同名/手工服务会列在 `unmanaged_dsh_services` 中，保留但不验证。若新命名服务与未管理服务同名，安装器给出 `Unmanaged MCP ... already exists` 并停止。
- 删除一个命名实例的注册（不删除其 runtime 数据）：

```powershell
node .\scripts\manage.mjs --remove-dsh-instance bravo
node .\scripts\manage.mjs --apply --remove-dsh-instance bravo
node .\scripts\manage.mjs --verify
```

删除只接受由 ai_rule managed 块管理、且真实存在的命名服务；不会动同名的非 managed 服务。要重新加回，用 `--enable-dsh` 和相应实例名。回执、锁和会话索引保留在原 runtime，便于人工核对；确认不再需要后由用户自行处理，不在安装器中自动删除。

新增/修复注册时如遇到 `Unmanaged MCP ... already exists`，说明同名服务不是 ai_rule 管理的，安装器拒绝覆盖。先人工合并配置，不要让两个服务争用同一个名称或 runtime。

## 4. 每个聊天如何选定并验证一个实例

1. 安装或更新注册后，先等当前活跃工作安全结束：保存结果，确认没有正在运行的 DSH 任务，不要在任务运行中重载或终止原 MCP 进程。然后使用宿主支持的 MCP 重载方式加载注册。仅新建聊天不证明注册已加载；本文不承诺当前 Codex 能在不中断的情况下热加载，也不认为必须重启整个 App，以宿主实际支持的方式为准。
2. 在 Codex 中运行 `codex mcp list`（或宿主等价的 MCP 列表），确认能看到 `dsh-opencode-go`、`dsh-opencode-go-alpha`、`dsh-opencode-go-bravo`。列表可见只证明注册存在，不证明当前聊天已加载或实际调用了所选实例。
3. 在聊天 A 输入类似：

   ```text
   本会话使用 DSH，固定使用 MCP 服务 dsh-opencode-go-alpha。
   由真实 Sol Max（max）协调子代理实际调用该 MCP；Astra 不转发。
   先调用 get_dsh_bridge_status，确认返回的 instance 是 alpha，再开始任务。
   后续不切换实例，除非我明确要求。
   ```

4. 在聊天 B 用另一段类似文字固定 `dsh-opencode-go-bravo`。两个聊天各自只调用自己的服务。
5. 由真实 Sol 在实际执行上下文中调用 `get_dsh_bridge_status`（启用日程时同时读取 `get_dsh_schedule_status`），核对 `instance`、`runtime`（运行目录）和峰谷配置；这是对新工具状态的实际读取，不能只看聊天文字或 MCP 列表。若宿主 UI 的服务器归属与状态不一致，停止并报告，不要仅凭聊天文字认定已切换。
6. 首次只做只读、小任务；确认 `task_id`、`session_id`、退出码和终态。不要把状态查询当成上游调用者的密码学证明；实际 MCP 发起方仍以宿主记录为准。

建议在会话交接中保存：`session_mode=DSH`、`dsh_instance=<name>`、`mcp_server=<name>`、协调者真实 agent ID、活动 `task_id`、`task_backend` 和授权范围。实例选择是会话调度状态，不写入共享仓库或 config.toml 的“当前聊天”字段。

## 5. 同一实例的续做、互斥和断连

- 同一实例同一时间只允许一个 DSH 子进程；多个聊天共用该实例时，后来者会收到 `Exclusive lock exists` 或 `DSH_BUSY`，应等待原任务，而不是重复启动或换键重跑。
- busy/lock 是**独立的预准入类别**。本阶段的 DSH→HY4 回退策略默认不因 busy/lock 转 HY4；除非有安全证据证明不是同一工作的重复提交。不得用回退绕过实例互斥、制造双跑或迁移已启动任务。
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
工作区写入仍需要本机安装层 `--allow-write` **且**当前任务有真实用户授权引用；`authorizationNote` 不是密码学令牌。实例划分不改变 DSH 的凭据、账户、配额、会话存储和操作系统文件权限：所有实例通常共享同一 Windows 用户、同一 DSH 凭据和同一底层模型额度。`read-only`/`workspace-write` 是传给 DSH 的权限预设，不是本桥接器实现的 OS 沙箱；工作目录不是文件访问隔离。

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

**首次启用默认服务**：可在首次添加命名实例时明确选择日程，默认只读：

```powershell
node .\scripts\manage.mjs --enable-dsh --dsh-instance alpha --dsh-instance bravo --offpeak-schedule
node .\scripts\manage.mjs --apply --enable-dsh --dsh-instance alpha --dsh-instance bravo --offpeak-schedule
node .\scripts\manage.mjs --verify
```

已有默认服务若明确要改日程，不要把它夹在添加实例的命令里。等当前活跃任务安全结束后，单独使用不带 `--dsh-instance` 的 `--enable-dsh` 管理操作；先预览，确认后再加 `--apply`：

```powershell
node .\scripts\manage.mjs --enable-dsh --offpeak-schedule
node .\scripts\manage.mjs --enable-dsh --disable-offpeak-schedule
```

若默认服务原本已授权写入并需要保留，按安装器参数显式加 `--allow-write`；不要为改日程额外开放写入。改策略不是日常更新默认行为，只在明确需要时执行。

电脑 B 的 runtime 会创建在自己的 `%LOCALAPPDATA%`，不会继承电脑 A 的锁、回执、会话或凭据。实例名相同不代表任务可迁移；跨电脑继续工作时，把目标、cwd、授权、必要输入和已有结果作为新任务交给电脑 B 的实例，不要复制 `RUN_RECEIPT.json`、`sessions.json` 或 `active.lock`。
同步更新后，不要仅靠新开聊天判断注册已加载：先等活跃工作安全结束，再使用宿主支持的 MCP 重载方式；随后由真实 Sol 在实际聊天中调用 `get_dsh_bridge_status`（启用日程时加 `get_dsh_schedule_status`），核对实例名、`runtime`（运行目录）和峰谷配置。本文不承诺无中断热加载，也不认为必须重启整个 App。

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
| `dsh_schedule_consistent=false` | 有的实例带日程、有的不带；按已启用规则统一，防止绕过峰谷。 |

## 9. 验收层级和明确限制

- **静态**：源码/配置解析、实例命名与路径规则、安装预览和 `--verify`。不等于已加载。
- **mock 回归**：`npm test` 使用 `tests/mock-dsh.mjs`，不访问付费 API；覆盖并行子进程、实例锁、幂等域、错误域、旧默认数据、日程/预算/硬停和安装器保留。测试运行环境与原安装隔离。它是独立层级，两次模拟任务也不能拼成“真实双跑”。
- **本机部署**：只有用户在本机运行安装器、按宿主支持的方式加载注册，并由真实 Sol 实际读取新工具状态后才成立；`--verify` 和 MCP 列表本身不够。
- **真实 DSH 并行**：两个聊天分别固定两个命名实例，各自完成真实 DSH 只读任务，且两个任务时间实际重叠。证据至少包括不同服务名与 runtime、实际 `task_id` 和 receipt 中的 `pid`、可核查的 `started_at`/`finished_at` 重叠、原生工具实际执行记录（至少 `native_tool_calls` 非零及结果）以及 `status`/`exit_code` 终态。仅聊天回复、mock 或模拟双跑不算。
- 本文不证明服务端真实型号、账单归属、供应商额度或 DSH 凭据隔离；桥接器仍记录 `actual_route=null`，除非另有独立证据。提供商额度另受账户和套餐限制，实例隔离不等于额度隔离。

建议的真实双跑验收（部署后执行，不是本次测试；本次交付不声称已完成）：

1. 两个聊天分别固定 `dsh-opencode-go-alpha` 和 `dsh-opencode-go-bravo`；按宿主支持的方式加载注册后，由真实 Sol 各自实际调用 `get_dsh_bridge_status`（启用日程时加 `get_dsh_schedule_status`），确认服务名、`instance`、`runtime` 不同，且峰谷配置符合本机策略（同一日程策略通常应一致）。仅新建聊天不算。
2. 在两个互不依赖的项目中各提交一个有用、只读、有界的代码勘察（例如项目 A 的入口与调用链、项目 B 的配置加载与错误路径），让两个真实 DSH 任务实际同时运行。记录双方实际 `task_id`、receipt 中的 `pid`、`started_at`/`finished_at`、`native_tool_calls` 和终态，确认时间区间重叠而非串行，并确认一个实例的 `get` 读不到另一个实例的 ID。不要用空目录、mock 任务或仅聊天问答代替。
3. 同一实例互斥要单独验收，且不要在该实例已有无关任务时强行追加请求。先确认实例空闲，再在两个聊天同时提交；第二个应得到 `Exclusive lock exists` 且不重复启动。原任务结束前不改锁、不取消、不重启。
4. 写入仍按本机安装开关和本次用户授权执行；先确认只读默认。不要为了验收扩权、复制凭据或跑无界双跑。

这两个真实任务已覆盖连通性，不需要再额外增加无用的付费连通测试；其额度消耗和可用性另受提供商账户/套餐限制。
