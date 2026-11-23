<!-- ai-rule-managed: 2026-11-23.astra-handoff-r1 -->
# WorkBuddy DSF

WorkBuddy DSF 是底层显式替代，不是全新默认；默认底层是 DSH/OpenCode Go `deepseek-v4.1-flash`。这里固定使用 `deepseek-v4-flash`，不要与 OpenCode Go 的路由混用。只有用户明确选择 WorkBuddy DSF，或既有模式 2 的实际峰时交接，才进入本入口；Terra 专家任务不因本入口可用而改派 WorkBuddy。

订阅 Sol 使用宿主加载的 `deepseek-v4-flash-workbuddy`。API Sol 使用本机协调配置所选的 WorkBuddy 连接。项目入口通过 `workbuddy.project_config` 指向同一本机项目 JSON，可直接复用项目授权。API 交接还须符合协调器配置的工作区和权限上限。

## 项目入口

从批准的任务目录和所需能力寻找适用的既有项目记录。项目入口使用已锁定的实际 WorkBuddy CLI、账户配置目录和 SDK，核对目录及执行流中的 `deepseek-v4-flash`，沿用厂商正常权限模式。

1. `get_task_bridge_status` 传本次绝对 `cwd`、`permissionMode` 与适用的任务限制。核对 `ready: true`、`project_contract: "project-v1"`、`model: "deepseek-v4-flash"` 和 `project_id`。
2. `run_workbuddy_task` 传 `projectId`（状态回执的 `project_id`）、`prompt`、`cwd`、`permissionMode` 和非秘密 `idempotencyKey`。按需要传 `timeoutMs`、`authorizationNote`、`capability` 及任务限制。由已选 WorkBuddy Harness 完整执行，同步返回回执。
3. 换论文、脚本、数据、任务名或同项目子目录时，在新任务书传当前输入与相关证据。沿用仍适用的项目授权、配置和已加载入口，使用新键。项目级能力范围内的常规派发无需新增 profile 或刷新服务。
4. 断连后用 `get_workbuddy_task` 和原 `idempotencyKey` 查询。续跑使用实际回执给出的 `session_id` 作为 `sessionId`、同项目、同 cwd 和原权限范围，并给续跑新键。保留原工作和续跑记录的关联。

### 写入和原生命令

- `allow_write` 是本机项目许可。项目允许写且本次获准时用 `permissionMode: "workspace-write"`。批准原生命令的项目还需 `allow_commands`。任务范围中的既有批准可写入 `authorizationNote`，例如已批准的实验文件更新及 MATLAB。
- 用户给出更窄的范围时，用 `capability: "workspace-write"` 搭配 `writes`、`writeScopes` 或 `commands`。`writes` 记录具体文件和 `create`/`edit`/`write`，`writeScopes` 记录现有目录和 `create`/`replace`/`edit` 的子集，`commands` 记录获准命令。给出文件范围时，命令还需匹配显式 `commands`。已批准的普通项目级命令范围无需为每次新任务重新登记。
- 文件工具在本次 cwd 内按路径和范围校验。获准命令以当前 OS 账户权限运行，受桥的命令校验和厂商正常权限模式约束。使用本次实际存在的宿主隔离与审批。

## 已有定制入口

按加载的实际 schema 使用现有 profile。Sol 核实固定模型、目录、批准范围和真实结果。API 定制连接只支持默认能力及实际 profile，结构化文件或命令范围由项目入口处理。新旧桥的任务参数、可用工具与续跑接口以实际加载的入口为准。模型、范围或能力不符时报告阻塞。
