# ai_rule

两台 Windows 电脑共用的 Codex 调度规则、Skill 和 DSH MCP 桥接器。桥接器/安装器版本 **v0.1.0**；规则修订 **2026-11-10.session-mode-r1**。

## 已落地与尚未验收

| 项目 | 本仓库状态 |
|---|---|
| 跨会话全局规则、调度 Skill | 已实现，可安装；保留宿主安全策略 |
| 会话模式保持 | 已写入 AGENTS/Skill；同一会话省略模式时沿用，明确选择才切换；不是程序强制路由 |
| 安装预览、合并、备份、冲突检测、回滚 | 已实现；不覆盖原有全局配置 |
| DSH 原生 headless stdio MCP | 已实现；同步/异步提交、等待、取消、回执、幂等、独占锁 |
| WorkBuddy 两个入口 | 原样保留；可注册用户已准备好的完整桥接器；电脑 B 暂不部署 |
| 现有 WorkBuddy 自定义源码迁移 | **未做**：当前不能读取用户本机完整源码，不能重建授权模块 |
| 原生 Sol/Luna 的模型 ID 和子代理配置 | 复用本机已有配置，不按角色名猜造 ID |
| 本机 DSH + Go 与 Codex 端到端验收 | 用户反馈两台电脑均通过文本/原生只读工具调用；未独立读取本机回执，不代表写入、长期监守或实际服务端型号已验收 |

默认 A：仅在全新会话尚未选择模式时启用，由 Sol Max 规划并执行，必要时 Luna 监守。
指定 HY4 / WorkBuddy DeepSeek / DSH：设为当前会话模式，Sol Max **只规划、调度、验收**；指定代理负责实际执行和自身监守，**不使用 Luna**。
后续消息不写模式时仍沿用当前选择，不会每轮恢复 A。Astra 负责总体方向。外部后端失败不得自动切回 Sol 或其他模型。

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

## 新会话怎么用：一次选择，持续沿用

在 Codex 会话输入框中发送，不是在 PowerShell 中执行：

```text
本会话使用 DSH 模式。读取当前生效的 AGENTS.md 和 multi-agent-dispatch Skill。
Astra 负责总体方向；Sol Max 只规划、调度与验收；DSH 负责实际执行、测试、修复及必要监守，不使用 Luna，不经过 OpenCode CLI。
除非我明确切换模式，否则本会话后续任务一直沿用 DSH，不因我省略模式而恢复默认。
只有全新会话从未指定模式时才使用默认 A；指定模式不等于授权所有写入，继续遵守每个任务的授权范围。
先简短确认当前模式与后端是否可用。第一个任务：先只读分析当前项目结构。
```

之后可以直接说“继续”“修改方案”“分析下一个模块”，无需重复选 DSH。更短的开场也可以是：

> 本会话使用 DSH，除非我明确切换，否则后续一直沿用；先只读分析当前项目。

| 用户表达 | 当前会话规则 |
|---|---|
| 全新会话直接布置任务，未选择模式 | 默认 A，由 Sol Max 执行 |
| “使用 DSH，分析……” | 将 DSH 设为会话模式，后续省略模式仍保持 |
| “切换为原生方案 A” | 后续使用 A |
| “仅本次用 HY4” | 仅该任务例外，结束后回到原模式；后端须已部署且可用 |
| “HY4 比 DSH 好吗？” | 只是讨论，不切换 |
| 已选 DSH，但 DSH 报错或不可用 | 报告阻塞，保留选择，不自动回退 A |

全新会话未指定时仍为 A，不自动继承另一会话或另一台电脑的模式。恢复原会话时保留有证据的原选择。
详细规则与手工验收场景见 [docs/session-modes.md](docs/session-modes.md)。

规则安装到有效的全局 AGENTS 文件，Skill 安装到 `~/.agents/skills/multi-agent-dispatch`。若存在非空 `AGENTS.override.md`，合并到这个实际生效的文件，不另写一份被忽略的 AGENTS。
文件只是持久行为规则，不会凭空增加模型权限或强制宿主实现不存在的子代理能力；项目级规则和当前指令仍可能影响行为，需新会话验收。

## 电脑 B：当前只部署 DSH

克隆同一仓库即可复用代码和规则，不需要重新写长提示词。机器环境和认证不会被 Git 自动同步。

先安装规则：`.\scripts\install.ps1 -Apply`。
待电脑 B 自己的 DSH、Go 凭据、headless 路由和会话插件准备好并测试通过，再运行 `-Apply -EnableDsh`。参考 `config/headless.patch.example.yml`，不要覆盖现有 profile。
按用户当前选择，电脑 B **暂不部署 WorkBuddy**；两个 `workbuddy_*_registered: false` 不影响已注册的 DSH。不自动安装 WorkBuddy，也不因缺少它们改变默认 A 或 DSH 会话选择。
今后用户明确需要时，才准备 WorkBuddy CLI 和完整定制桥接器；见 `bridges/workbuddy/README.md`。本仓库不会把 A 的私有凭据或绝对路径复制到 B。

## 更新、回滚与测试

### 仅同步规则和 Skill（适用于本次会话模式修订）

在需要更新的每台电脑执行：

```powershell
Set-Location "$env:USERPROFILE\ai_rule"
git pull --ff-only
# 如果 pull 报错或本地有冲突，停止，不要 reset --hard 或覆盖本地修改。
node .\scripts\manage.mjs
# 预览应只有 AGENTS 和 Skill；确认后再执行。
node .\scripts\manage.mjs --apply
node .\scripts\manage.mjs --verify
```

不带 `--enable-dsh` 或 `--workbuddy-bridge` 时，仅更新规则和 Skill；不删除已有 DSH MCP，不重写 config.toml，也不改变已有 AllowWrite 设置、凭据或 DSH Profile。安装器仍显示 v0.1.0 是正常的，本次只修订规则。
完成后重启 Codex 并打开新会话，让新规则加载。已在进行的会话可以直接发送上面的会话模式声明；不要假定远端提交会自动更新其上下文。

### 同时更新 MCP 注册配置

```powershell
git pull --ff-only
.\scripts\install.ps1 -EnableDsh
.\scripts\install.ps1 -Apply -EnableDsh
npm test
```

已经启用写入的电脑，在重写 MCP 配置时明确带上 `-AllowWrite`；省略则恢复只读。仅同步规则的上一组命令不改变这个设置。
安装会输出本机回滚 manifest 路径。用 `.\scripts\install.ps1 -RollbackManifest "该路径"` 回滚。文件在安装后又被修改时，回滚拒绝覆盖，需手工合并。
备份保存在 Codex home 的 `ai-rule-backups`，可能包含已有配置中的秘密，仅保留本机，禁止上传。

测试、权限边界和恢复说明见 [docs/implementation.md](docs/implementation.md)。其中 2026-11-09 的开发验收记录是当时状态，不应与后续用户反馈混为一谈。
