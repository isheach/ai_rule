# 保留已有 WorkBuddy 桥接器

本仓库不重建用户的定制 WorkBuddy server.mjs：目前只有部分代码片段，不能安全重现其授权 profile、实验 runner 及监守扩展。

安装器默认保留 `hy4-workbuddy` 与 `deepseek-v4-flash-workbuddy` 的现有配置。第二台电脑如已有完整桥接器，可执行：

```powershell
.\scripts\install.ps1 -WorkBuddyBridge "D:\实际位置\完整桥接器\server.mjs"
.\scripts\install.ps1 -Apply -WorkBuddyBridge "D:\实际位置\完整桥接器\server.mjs"
```

只有缺少的 MCP 条目才会添加，已存在的同名条目不覆盖。WB_MODEL 分别设置为 hy4-preview / deepseek-v4-flash；脚本必须确实读取该变量。
所有伴随模块、策略配置、依赖和本机认证须先齐备。只复制 server.mjs 并不足够。
本安装器不会调用 WorkBuddy、提交研究任务或验证长任务监守；需在本机分别调用状态工具及一次批准的测试。
不要上传凭据、研究数据、私人日志或未经审核的整个旧工作目录。
