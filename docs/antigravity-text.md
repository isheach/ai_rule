# Antigravity 纯文本入口

此入口通过已配置的 `sol-coordinator` 接收纯文本任务，模型由 Antigravity CLI (`agy`) 实际可用目录和本机别名配置决定。它使用独立的 Google 凭据及计费渠道，不经过 OpenAI Windows broker，也不替代 GPT-6.1 Terra Max 的主机操作、验收、绘图或图像能力。本页描述接口和需要验证的条件；当前源码与隔离测试不能证明用户机器、远端主机、认证或真实模型已就绪。

## 路由与兼容

- 显式 `purpose: "writing"` 且省略 backend 时，只有该 `sol-coordinator` 已配置 `antigravity` 才默认使用 Antigravity。未配置的旧安装仍沿原 Terra 路径；已受理任务与回执继续使用原来源、后端和所有者。显式 `backend: "Antigravity"` 遇到缺失配置时报告缺项，不自动切换后端。
- `computer_operation`、`acceptance`、`image_generation`、`image_recognition` 保留 Terra 路径；显式 `backend: "Terra"` 的 writing 继续使用原入口和原计费同意。一般编码和工作仍按原 DSH/WorkBuddy/A/HY4 选择执行。
- subscription 与 API 协调来源使用相同的 `sol-coordinator` handoff schema；Antigravity 的认证独立于 Sol/Terra/Luna 的来源，不自动切换 Google 账户、凭据或付费渠道。既有直接订阅 Terra 入口仍以宿主提供的代理和工具为准。

## 配置与动态模型

在所选 `sol-coordinator` 本地配置中提供 `antigravity` 对象，字段为绝对路径 `binary`、`runtime_dir`、`models_file`，以及 `credential_source`。后者只可选 `gemini-api-key` 或 `enterprise-adc`；企业 ADC 还须在 `adc_credentials_file` 中指定明确、受信且实际存在的凭据文件。路径和文件须按目标宿主、身份与现有授权核实；二进制、模型文件、运行目录和 ADC 凭据不得与获准工作区及其他服务状态重叠，运行目录也不得包含二进制、模型或凭据文件。不要把真实密钥、个人配置或日志提交到仓库。

模型目录文件的结构示例：

```json
{
  "default_model": "draft",
  "models": {
    "draft": { "id": "<从实际 agy models 返回的 slug>", "effort": "high" }
  }
}
```

`draft` 是项目可配置别名，不是上游模型名；`id` 必须替换为所选身份实际可用的 slug，`effort` 必须适用于所选模型。目录文件每次读取可反映别名、默认模型和已批准模型的变更；新增模型无需为每个模型再开发接口或部署一遍。初次更新并加载含新接口的 JS MCP 仍需目标宿主按实际支持的方式重新加载；模型文件热更新本身无需重新部署程序。

## 查看状态与提交

1. `get_antigravity_status` 只做静态只读配置检查，不运行 agy、请求模型或证明远端连通、认证、权限、模型可用性或文本隔离。`list_antigravity_models` 实际运行 `agy models` 获取模型元数据，不发生成任务；它涉及真实本机程序及可能的认证、网络或本机状态，只在已授权的目标宿主执行。安全准备范围限于该列表和 `agy --version`，不以其作为生成成功的证据。模型文件尚无已登记别名时也可列出上游目录，前提是配置的路径和目标运行资源已按宿主要求就绪；列表的 `ready: null` 不代表可生成。
2. 用户明确授权 Google 这一路的计费与发送的上下文后，新建 `run_sol_coordination` 或 `start_sol_coordination` 任务：沿用原来必须的 `context`、`idempotencyKey`、`goal`、`cwd`、`permissionMode`、`acceptance` 和所选来源。传 `purpose: "writing"`、`permissionMode: "read-only"`，`capability` 使用 `text-only` 或入口原有默认值，并对每个新任务显式传 `acceptAntigravityUsage: true`。需要指定模型时传 `antigravityModel` 的配置别名，不指定时使用文件的 `default_model`。已有仍有效的授权可沿用，但字段本身、上下文摘要和调用者标签不能代替授权。
3. `start` 返回后，继续使用原 `taskId`、原幂等键及该入口的 `get/wait/cancel_sol_coordination`；同步 `run` 按实际结果收尾。写权限、命令、文件范围或主机动作不属于该入口。受理不明、断连、超时先查原回执，不换键重提或回退其他来源。

以下仅为字段示意，必须替换占位符并在已有明确授权、目标宿主和隔离条件成立后提交；订阅及 API 协调来源使用相同结构：

```json
{
  "context": "<实际宿主发出的 context_ref>",
  "idempotencyKey": "<本任务的新非秘密键>",
  "coordinatorMode": "subscription",
  "purpose": "writing",
  "goal": "<已批准发送的文本任务>",
  "cwd": "<已批准的绝对项目路径>",
  "permissionMode": "read-only",
  "capability": "text-only",
  "acceptance": "<本任务验收条件>",
  "antigravityModel": "draft",
  "acceptAntigravityUsage": true
}
```

示例中的 `cwd` 仍用于协调器验证已批准范围；CLI 的实际工作目录为隔离的非 Git 工作区。`draft` 须是本地模型目录已有别名，不是固定或内置的模型。选择 API 协调来源时，只在用户已选择的前提下使用该来源，不改变 AGY 的 Google 身份。

## 一般任务中的文本协作

用户已明确授权 Google 的身份、计费及将要发送的上下文时，一般任务可以由原 Sol 自行委派需要的文字子任务，无需用户先手工拆分任务。父任务继续由原 Sol 负责，保留原协调来源、权限、执行者和预算；Antigravity 子任务只接收与目标和验收有关、可共享的文本，不继承文件、命令、电脑或图像操作能力。

- **API 父协调**：新 handoff 明确传 `acceptAntigravityUsage: true`，可选 `antigravityModel` 指定本机已登记别名，省略则采用该次接单时的默认别名。模型选择在父任务受理时冻结，后续修改模型文件只影响后来的任务。受保护 broker 的现有 `delegate_peer` 确已就绪时，API Sol 在自己的工具循环使用 `delegate_peer({ peer: "antigravity", goal, acceptance, contextSummary })`，等待子任务及其回执并完成父任务验收；这条 Google 路径不要求 `acceptPeerCharges`。如还要使用 Terra 或 Luna API，仍须各自满足原有授权、`acceptPeerCharges:true` 和相应模型就绪条件，不能把 Google 授权当成 OpenAI 协作授权。
- **订阅 Sol**：原 Sol 可在授权及已加载能力范围内，使用 `run/start_sol_coordination` 的 Antigravity 写作入口并用该文本子任务原有的稳定键查询与续等；或在宿主实际注入 `nativeAntigravity` 适配器时，用 `delegatePeer({ peer: "antigravity", goal, acceptance, contextSummary, idempotencyKey })`。仍由原 Sol 接收结果与验收，不改变父任务所有者；适配器不存在或隔离条件不足时如实报告。

使用原生适配器时，父任务的 `task.acceptAntigravityUsage` 须为 `true`，并在 `task.antigravityModel` 指定已批准的别名。在订阅宿主的适配器里，用宿主已核实的 `context_ref` 调用同一个 `run_sol_coordination`。从 `dispatch({request, authorization, signal})` 使用 `request.idempotencyKey`、`request.modelAlias`（传为 `antigravityModel`）、`request.goal`、`request.acceptance`、`request.contextSummary` 和适用的 `request.constraints`。用 `authorization.cwd` 验权，并在父任务剩余预算内设置 `timeoutMs`。固定传 `coordinatorMode:"subscription"`、`purpose:"writing"`、`backend:"Antigravity"`、`permissionMode:"read-only"`、`capability:"text-only"` 和已批准的 `acceptAntigravityUsage:true`。用宿主的 `signal` 接续或停止原调用，并把原结构化回执返回给 Sol。

只读的 `get_sol_coordinator_mode` 返回 `peer_route_diagnostics`。在已核实目标宿主与身份的命令入口，也可用 `node bridges/sol/cli.mjs luna-status --config <ABS>` 查看 Luna，或用一次 `peer-status` 查看同一回执中的协作路由诊断；这些状态检查不等于真实模型调用。诊断显示的安装结构、broker 准备情况、模型就绪和实际调用证据应分别报告。检查 AGY 协作时还须独立核实 Google 配置及 broker 对 `delegate_peer` 的支持，不能把 Terra/Luna 诊断当成 AGY 已就绪。

## 本机隔离与证据

仅在确有授权且所选身份与版本符合要求时执行：使用独立临时 profile 和非 Git 工作区，隔离项目及全局规则、技能、插件、MCP 和 hooks；使用自定义无动作工具 agent，以流式 stdin 运行，核验实际 `init`、工具清单为空及其他隔离条件后才发送任务文本；当前实现要求兼容的 1.x CLI 且版本至少 1.5。无法证实任何必要边界、身份、版本或初始化状态时阻断并报告，不能把模型自述当作隔离证明。官方文档说明自定义 agent 的 `send_message` 仍会包含，空工具列表及启动行为不应未经验证地视为零能力。任何可执行的 `send_message` 或其他动作工具存在时须在发送任务文本前阻断；事后检测到 `tool` 事件时，动作可能已经发生，不能据此宣称事前隔离。

实际任务保留最小必要的进程、版本、所选配置别名与请求模型、初始化与终态回执、退出码和可用 usage。文档化的 `init.model` 是运行配置，JSON 终态文档未列出服务端实际模型字段，不能把指定 slug 写成已由服务端独立确认的模型。注意版本差异：被 `--print-timeout` 截断的旧版可能返回部分文本及退出码 0，后续版本有 `finished_reason`，v1.5.0 又改为退出码 3。逐项检查中断、拒绝动作和真实终态；未知、缺失或冲突不能算完成。不能用 `SUCCESS`、退出码 0、文本答复或模拟测试声称没有本机动作、现场已就绪或 Google 实际计费已核实。

`gemini-api-key` 使用宿主标准 `GEMINI_API_KEY`，`enterprise-adc` 使用所配置的受信实际文件。两者的认证、模型可用性和计费可能不同。Google 的 FAQ 区分直接运行 headless 脚本/CI 与把 `agy` 封装在第三方编码代理或应用内：后者在消费方案下不受支持。不要自动套用消费登录或转到其他身份；具体账号与适用条款由目标环境核实。密钥和凭据只留在目标机器，不放进模型目录、任务摘要、回执或仓库。

## 与既有 broker 的边界

Antigravity 不使用 OpenAI broker，接入它不要求重新部署已经激活 Luna 的 C# broker。未激活 Luna 的旧 broker 如需 Luna，仍按原有授权与受保护流程做一次升级；不要为 AGY 模型增减重复升级 broker。运行中的任务沿原宿主、MCP 进程及回执收尾。

## 官方参考

- [Headless mode](https://antigravity.google/docs/cli/headless/)：输出、模型选择、初始化事件及无头权限。
- [CLI reference](https://antigravity.google/docs/cli/reference/) 和 [CLI changelog](https://antigravity.google/docs/changelog?tab=cli)：参数与版本差异、超时终态、模型列表格式。
- [Permissions](https://antigravity.google/docs/permissions?tab=cli)、[Settings](https://antigravity.google/docs/cli-settings)、[Hooks](https://antigravity.google/docs/hooks?tab=cli)、[MCP](https://antigravity.google/docs/mcp?tab=cli) 和 [Customization discovery](https://antigravity.google/docs/customization-discovery?tab=cli)：默认权限和配置加载边界。
- [Build plugins](https://antigravity.google/docs/build-plugins/)：自定义 agent 工具配置；[Authenticate](https://antigravity.google/docs/install?tab=cli)：认证与远程 SSH；[FAQ](https://antigravity.google/docs/faq/)：第三方封装的支持范围。
