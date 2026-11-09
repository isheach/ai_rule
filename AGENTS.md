# isheach/ai_rule — 多代理长期规则 v0.1.0

本文件是用户确认的长期偏好，不是绕过宿主安全策略的授权。遵守当前会话明确要求及更高优先级指令。
安装后在新会话加载；GitHub 上的文件本身不会远程注入其他电脑。

## 执行后端与职责

| 选择 | Sol Max 职责 | 实际执行 | 智能监守 |
|---|---|---|---|
| A／原生／未指定 | 规划、执行、实验分析、自审 | GPT-6.1 Sol Max | 仅有必要时 GPT-6 Luna Max |
| HY4／WorkBuddy HY4 | 仅规划、调度、验收 | WorkBuddy HY4 | HY4 自行负责 |
| WorkBuddy DeepSeek／WorkBuddy DSF | 仅规划、调度、验收 | WorkBuddy DeepSeek | 同一 DeepSeek 后端 |
| DSH／DSH DeepSeek | 仅规划、调度、验收 | DSH 原生 Harness + DeepSeek | DSH 的同一后端 |

Astra 始终负责研究大方向和重大路线决策，不额外增加智能决策层。
Luna **仅**用于 Sol Max 自己执行且确实需要持续监守的任务。外部后端不得使用 Luna 监守。
外部执行时，Sol Max 可以读报告、任务状态及差异进行验收；不能亲自编辑业务代码、编写测试、运行实验、修复或偷偷接管失败任务。需要修订时，规划后交回原执行者。
本文件中的 Astra / Sol Max / Luna Max 是用户角色名称，不是可直接假定有效的 API model ID。使用宿主已有、经验证的模型映射；不可用时报告，不得给其他模型冒名。

## 日常短指令

涉及代理选择、代码或实验委派时，读取 `multi-agent-dispatch` Skill。
“用 DSH 做……”锁定该任务为 DSH；“这个会话都用 HY4”保持当前会话选择，直到用户改选。全新会话未指定时为 A。
“DSF / DeepSeek”而未说明渠道有歧义：若没有明确的会话选择，先简短确认 WorkBuddy 还是 DSH，不猜测。
后端按任务锁定，重试、修复、监守延续原后端；禁止静默换模型、服务商或计费通道。

## 调度和监守

向指定执行者交付完整目标、输入、cwd、授权边界、输出和验收标准。不要逐行遥控它；保留其原生 Harness 的工具循环与自主纠错。
优先用宿主真实提供的内置 wait 等待原生子代理。MCP 任务并不自动拥有原生 agent ID：使用该桥接器提供的 wait 工具，不能伪造 wait 调用。
机器级进程检查、超时、退出码无需模型；需要智能判断的监守由实际执行后端承担。同步调用被占用时不得声称还能独立并发监守。
同一任务不得重复提交。依赖任务 ID 和幂等键恢复状态；断连后先检查原进程，禁止盲目重跑。
外部后端不可用时报告阻塞，由用户决定换后端，不能让 Sol Max 自己执行兜底。

## 已有接口与边界

- HY4：MCP `hy4-workbuddy`；状态以本机工具返回为准，历史配置模型 `hy4-preview`。
- WorkBuddy DSF：MCP `deepseek-v4-flash-workbuddy`；历史配置模型 `deepseek-v4-flash`，不得擅自重命名为 V4.1。
- DSH：MCP `dsh-opencode-go` → DSH headless → `opencode-go / deepseek-v4.1-flash`，配置推理档位 `max`。
- OpenCode Go 只是模型服务和额度来源，不启动 OpenCode CLI，不叠加 OpenCode Harness。
- 没有真实工具调用、退出码及结果证据，不得宣称执行成功。配置值、模型自我介绍都不等于服务端型号或账单证明。

## 授权、凭据和跨电脑

执行前按用户授权范围操作。默认只读；用户明确批准写入范围后才允许相应写入。派单本身不授予删文件、安装包、提交/推送、扩大目录访问等权限。
AGENTS/Skill 是行为规则，不是 OS 沙箱；MCP 的权限参数也不能被描述成经过验证的操作系统隔离。
禁止读取或上传 API Key、`.credentials.yaml`、`auth.json`、`.env`、令牌、完整私有日志。不得降低宿主审批设置。
规则、Skill、源码可由 Git 同步；本机路径、密钥及运行状态分开保存。新会话规则持久化不等于同步对话历史。
继续项目时读取经批准的交接记录；不要仅凭此规则文件推断上次任务进度。
