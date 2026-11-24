<!-- ai-rule-managed: 2026-11-24.plan-b-r1 -->
# Antigravity 纯文本路由

仅对已配置 `antigravity` 的 `sol-coordinator`，新任务显式 `purpose: "writing"` 且省略 backend 时默认 Antigravity。未配置的旧安装和已受理回执沿原路由；显式 `backend: "Antigravity"` 但缺配置时报告缺项，不回退。`computer_operation`、`acceptance` 和 `image_generation`/`image_recognition` 保留 Terra；明确选 `backend: "Terra"` 的写作继续使用原 Terra 入口与计费规则。订阅和 API 协调来源可使用同一 handoff；Antigravity 自己的凭据、模型、额度和计费独立于 OpenAI broker。

## 配置与模型

`sol-coordinator` 的 `antigravity` 本地配置包含 `binary`、`runtime_dir`、`models_file`、`credential_source`。路径使用目标宿主核实的绝对路径；二进制、运行目录、模型和 ADC 凭据不得与批准工作区或其他服务状态重叠，运行目录也不得包含这些文件。来源为 `gemini-api-key` 或 `enterprise-adc`，后者另指定受信且实际存在的 `adc_credentials_file`。前者只使用目标宿主的标准 `GEMINI_API_KEY`；不要提交密钥，不从其他来源静默回退。用户授权不同 Google 身份、计费及所发送上下文后才进行生成；Google 消费方案不支持把 `agy` 封装进第三方编码代理或应用。企业/API 身份按其实际授权和条款核实。

模型文件示意（`id` 占位符必须替换为目标身份在 `agy models` 中实际可用的 slug）：

```json
{"default_model":"draft","models":{"draft":{"id":"<实际 agy models slug>","effort":"high"}}}
```

每次按需读取目录，`antigravityModel` 选项目别名，省略则用 `default_model`。新增模型通过已批准的文件变更登记，不用为每个模型修改程序或重新部署。首次安装或更新此 JS MCP 后按宿主入口重载；已激活的 Luna/OpenAI broker 不因 Antigravity 或模型目录变化而重部署。旧 broker 未激活 Luna 且需用 Luna 时，仍按原有授权和受保护流程升级。

## 查询、提交与恢复

1. `get_antigravity_status` 静态只读，不启动 CLI，也不证明目标机、账号或真实模型就绪。`list_antigravity_models` 实际运行 `agy models`，取模型元数据而不生成；安全准备仅在授权目标机执行它或 `agy --version`。尚无模型别名时也可发现上游目录，须按目标宿主要求配置好路径和运行资源；结果的 `ready: null` 不表示已就绪。模型列表本身不是生成、计费或隔离证据。
2. `start_sol_coordination` 与 `run_sol_coordination` 使用原入口相同的必需字段、权限与来源规则。纯文本请求使用 `purpose: "writing"`、`permissionMode: "read-only"`，能力限 `text-only` 或原有默认能力；每个新任务须传 `acceptAntigravityUsage: true`，并可用 `antigravityModel` 选择已配置别名。此前仍有效的计费及上下文授权可沿用，但字段、上下文与调用标签本身不构成授权。不可用时报告阻塞，不把 AGY 当成本机操作入口。
3. `start` 返回后，用原 `taskId`、原键和所选入口的 `get/wait/cancel_sol_coordination` 查询、等待或取消；未知、超时、断连先查原回执，不重提、换源或迁移。记录实际执行宿主、选择、版本、初始化、终态与可得 usage。配置模型名、进程成功及生成文本不证明服务端实际模型、无工具动作或账单。

## 一般任务中的文本协作

原 Sol 可把一般任务中确有需要的写作子任务交给 Antigravity，不要求用户手工拆分；只发送已批准、与子任务相关的可共享文本。父任务的来源、所有者、权限和预算继续有效，AGY 子任务限只读文本。

- API 父 handoff 有明确计费与上下文授权时传 `acceptAntigravityUsage: true`，可选 `antigravityModel`；省略时采用受理时的默认别名，接单后该选择冻结。已受保护 broker 的 `delegate_peer` 真正就绪时，API Sol 用 `delegate_peer({ peer: "antigravity", goal, acceptance, contextSummary })` 委派并等待。AGY 不要求 `acceptPeerCharges`；Terra/Luna API 仍按各自授权、`acceptPeerCharges:true` 和原模型就绪要求执行。
- 订阅 Sol 可用 `run/start_sol_coordination` 的 AGY 写作入口及该子任务原有的稳定键，或通过宿主实际提供的 `nativeAntigravity` 用 `delegatePeer({ peer: "antigravity", goal, acceptance, contextSummary, idempotencyKey })`。原 Sol 接收和验收；缺入口或隔离证据时报告阻塞，不转移父工作所有者。

`get_sol_coordinator_mode` 的 `peer_route_diagnostics` 记录 Terra/Luna 路由诊断；在目标宿主也可用 `node bridges/sol/cli.mjs luna-status --config <ABS>` 或一次 `peer-status`。只读诊断不代替真实调用，AGY 的 Google 配置及 broker `delegate_peer` 支持须另核实。

## 隔离与版本边界

生成应在独立临时 profile、非 Git 工作区中，以自定义无动作工具 agent 和流式 stdin 启动；在发送任务文本前核验实际 `init` 的工具清单为空及认证和隔离状态；当前入口要求兼容的 1.x CLI 且版本至少 1.5。工作区外的全局规则、skills、hooks、plugins、MCP 仍需隔离；`read_file` 在工作区默认可自动允许。无法证明必要条件或发生版本差异时停止，不能依赖提示词、空目录、软拒绝或 `--allowed-tools` 未经证实的用法。官方文档称 `send_message` 始终包含于自定义 agent 工具，空列表语义和启动时钩子并未据此得到证明。若该工具或其他动作工具可执行，须在发送任务文本前阻断；收到动作事件后才拒绝并不能证明动作未发生。

终态除退出码与 status 外，还需处理实际版本的截断、拒绝动作及终态字段。旧版本超时可能返回部分内容和 0；v1.4.11 有 `finished_reason`，v1.5.0 将超时改为退出码 3。无现场认证、无工具隔离和真实调用证据时明确报告未验证。

官方依据：[headless](https://antigravity.google/docs/cli/headless/)、[CLI 更新日志](https://antigravity.google/docs/changelog?tab=cli)、[权限](https://antigravity.google/docs/permissions?tab=cli)、[hooks](https://antigravity.google/docs/hooks?tab=cli)、[自定义发现](https://antigravity.google/docs/customization-discovery?tab=cli)、[认证](https://antigravity.google/docs/install?tab=cli)、[FAQ](https://antigravity.google/docs/faq/)。
