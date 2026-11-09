# ai_rule

两台 Windows 电脑共用的 Codex 调度规则、Skill 和 DSH MCP 桥接器。首版 **v0.1.0**。

## 已落地与尚未验收

| 项目 | 本仓库状态 |
|---|---|
| 跨会话全局规则、调度 Skill | 已实现，可安装；保留宿主安全策略 |
| 安装预览、合并、备份、冲突检测、回滚 | 已实现；不覆盖原有全局配置 |
| DSH 原生 headless stdio MCP | 已实现；同步/异步提交、等待、取消、回执、幂等、独占锁 |
| WorkBuddy 两个入口 | 原样保留；可注册用户已准备好的完整桥接器 |
| 现有 WorkBuddy 自定义源码迁移 | **未做**：当前不能读取用户本机完整源码，不能重建授权模块 |
| 原生 Sol/Luna 的模型 ID 和子代理配置 | 复用本机已有配置，不按角色名猜造 ID |
| 本机 DSH + Go 与 Codex 端到端验收 | **待用户电脑验证**；本仓库模拟测试不是付费模型调用证明 |

默认 A：Sol Max 规划并执行，必要时 Luna 监守。
指定 HY4 / WorkBuddy DeepSeek / DSH：Sol Max **只规划、调度、验收**；指定代理负责实际执行和自身监守，**不使用 Luna**。
Astra 负责总体方向。外部后端失败不得自动切回 Sol 或其他模型。

DSH 路径：`Codex → MCP → DSH 原生 Harness → OpenCode Go 模型 API`。
**没有 OpenCode CLI / OpenCode Harness 这一层。**

## 电脑 A：已有 DSH 成功配置，直接安装

使用当前能运行 `dsh --profile headless` 的同一 Windows 用户。需要 Git、Node；本仓库无第三方 npm 依赖，不必 `npm install`。
Node 最低 22 是本仓库要求；DSH 自身可能要求更高版本，使用已经成功运行 DSH 的那套 Node。

```powershell
git clone https://github.com/isheach/ai_rule.git "$env:USERPROFILE\ai_rule"
Set-Location "$env:USERPROFILE\ai_rule"

# 预览：只探测 CLI/配置，不发起付费模型请求、不修改文件
.\scripts\install.ps1 -EnableDsh

# 查看预览无误后安装：默认只读 DSH 执行
.\scripts\install.ps1 -Apply -EnableDsh

# 检查持久化文件/注册情况；此处仍不是真实模型验收
.\scripts\install.ps1 -Verify
```

若系统策略阻止 `.ps1`，不必修改执行策略，直接运行等价的 Node 命令：

```powershell
node .\scripts\manage.mjs --enable-dsh
node .\scripts\manage.mjs --apply --enable-dsh
node .\scripts\manage.mjs --verify
```

安装器自动识别 npm 全局 DSH 的 JavaScript 入口、用户目录和 Node 路径。识别失败时用 `-DshEntry "实际的\@deepseek-ai\dsh\lib\bin.js"`；不要传 `.cmd` 或 `.ps1` shim。
它不会重新安装 DSH、修改 profile 或读取凭据文件；预检查会核实 headless 的配置路由与 JSON/权限选项。预检查不通过就停止。

安装后**完全重启 Codex并新开会话**，再运行 `codex mcp list`。已有 HY4/WorkBuddy DeepSeek 配置不动。

### 第一次端到端验收

在 Codex 新会话输入：

> 使用 DSH。先调用 get_dsh_bridge_status，再在一个已经存在的空测试目录中，通过 run_dsh_task 做只读文本测试。提供任务 ID、退出码、final_reason 和回执，不要用模型的自我介绍证明身份。Sol Max 不代执行。

目录必须是真实绝对路径。完成后再批准一个读取测试文件的任务，核实回执中的 native_tool_calls，而不是立刻开始真实项目写入。

### 开放经批准的工作区写入

默认是只读。完成验收并决定让 DSH 做代码修改时，显式运行：

```powershell
.\scripts\install.ps1 -Apply -EnableDsh -AllowWrite
```

这只允许 MCP 接受 workspace-write 请求；每次任务仍需对应用户授权，传入 authorizationNote。它不是永久授权所有写入，更不授权安装、删除、提交或推送。宿主审批规则不修改。
若要恢复只读，再执行不带 `-AllowWrite` 的安装命令并重启 Codex。

## 新会话怎么用

- `使用 DSH，分析当前项目的回测瓶颈，先只读。`
- `使用 HY4，按已批准的范围修复这个问题。`
- `使用 WorkBuddy DeepSeek，完成这组实验并自行监守。`
- `使用原生方案，由 Sol Max 执行。`

规则安装到有效的全局 AGENTS 文件，Skill 安装到 `~/.agents/skills/multi-agent-dispatch`。若存在非空 `AGENTS.override.md`，合并到这个实际生效的文件，不另写一份被忽略的 AGENTS。
文件只是持久行为规则，不会凭空增加模型权限或强制宿主实现不存在的子代理能力；项目级规则和当前指令仍可能影响行为，需新会话验收。

## 电脑 B

克隆同一仓库即可复用代码和规则，不需要重新写长提示词。机器环境和认证不会被 Git 自动同步。

先安装规则：`.\scripts\install.ps1 -Apply`。
待电脑 B 自己的 DSH、Go 凭据、headless 路由和会话插件准备好并测试通过，再运行 `-Apply -EnableDsh`。参考 `config/headless.patch.example.yml`，不要覆盖现有 profile。
WorkBuddy 安装与已有定制桥接器的伴随文件仍需在 B 上准备；见 `bridges/workbuddy/README.md`。本仓库不会把 A 的私有凭据或绝对路径复制到 B。

## 更新、回滚与测试

```powershell
git pull --ff-only
.\scripts\install.ps1 -EnableDsh
.\scripts\install.ps1 -Apply -EnableDsh
npm test
```

已经启用写入的电脑，更新时明确带上 `-AllowWrite`；省略则恢复只读。
安装会输出本机回滚 manifest 路径。用 `.\scripts\install.ps1 -RollbackManifest "该路径"` 回滚。文件在安装后又被修改时，回滚拒绝覆盖，需手工合并。
备份保存在 Codex home 的 `ai-rule-backups`，可能包含已有配置中的秘密，仅保留本机，禁止上传。

测试、权限边界和恢复说明见 [docs/implementation.md](docs/implementation.md)。
