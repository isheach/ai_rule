<!-- ai-rule-managed: 2026-11-24.plan-b-r1 -->
# 安装前置与验收

新装前置：Node ≥22。实际可用的 Codex 宿主。默认 DSH 需要已安装且可运行的 headless 路由 `opencode-go`/`deepseek-v4.1-flash`/max 和匹配工作区的协调配置。WorkBuddy DSF 不是新装前置，只有本机 `workbuddy` 入口/项目已配置并显式选择时可用。未配置的 API 请求返回 `WORKBUDDY_NOT_CONFIGURED`，不回退 DSH。API 来源还需已安装受保护 broker/`sol-coordinator` 配置。订阅来源由宿主提供真实原生模型。

部署或迁移限于已有授权。核实目标机器、身份、入口、绝对路径与 Git 修订。有目标入口时在授权范围内完成。访问、安装或所选入口受阻时报告受影响步骤和证据，由原所有者完成仍可独立进行的源码、规则或离线工作。本机接续按目标宿主实际支持的入口执行，活动任务继续使用原有宿主与 MCP 进程。

安装器将全局规则的受管理块写入实际生效的 Codex 全局 AGENTS 或非空 override，将 Skill 与 `references/*.md` 写入目标用户主目录的 `.agents/skills/multi-agent-dispatch/`。AGENTS 通过已安装 Skill 名称进入，Skill 内的相对参考链接以该 Skill 目录为基准。不要把仓库根的相对路径写入全局 AGENTS。实际安装、升级、回滚与服务重启仍以项目授权、具体安装计划和宿主配置为准。

按任务范围分开验收源码或规则、目标机结构安装、实际宿主代理与工具就绪、获准的真实模型调用。结构检查不证明宿主就绪或真实调用。保留各项证据和未验证部分。普通 PowerShell 的代理状态只覆盖该 Windows 调用身份，API 计费验收以真实 Responses 回执及账单为准。
