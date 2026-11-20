# WorkBuddy DSF 桥接器

`project-server.mjs` 提供 `deepseek-v4-flash-workbuddy` 的项目入口。`project-config.mjs` 校验实际 WorkBuddy CLI、账户目录和项目配置。`project-policy.mjs` 与 `project-sdk.mjs` 使用本机授予的项目能力和更窄的任务约束。在 DSH 模式 2 实际峰时，`dispatch.mjs` 维护领取与回填记录。 [安装与验收](../../docs/workbuddy-project-entry.md) · [峰时派发](../../docs/offpeak-schedule.md#模式-2-的峰时派发)

## 已有定制入口

仍使用定制桥的机器按已加载的真实 schema、既有 profile 和权限运行。定制实现包括实际 `server.mjs`、伴随模块、权限配置、依赖和本机认证，由原工作目录维护。已有完整实现并需要增加缺少的旧入口时，可预览并按本机实际路径安装。

```powershell
.\scripts\install.ps1 -WorkBuddyBridge 'D:\实际位置\完整桥接器\server.mjs'
.\scripts\install.ps1 -Apply -WorkBuddyBridge 'D:\实际位置\完整桥接器\server.mjs'
```

旧入口的 `WB_MODEL` 分别为 `hy4-preview` 和 `deepseek-v4-flash`。实际加载桥、模型和结果由 Sol 验收。API Sol 可按原工具的实际映射接入定制 DSF。官方 CodeBuddy ACP 的固定 `hy4free` 另有独立入口。 [定制 DSF 配置](../../docs/sol-coordinator.md#已有定制入口) · [官方 ACP](../../docs/codebuddy-acp.md)
