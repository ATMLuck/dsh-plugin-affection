# DSH 情感聊天

为 DeepSeek Harness 的角色预设编写独立人格、选择工具并保存跨聊天的情绪。适配 DSH `0.2.2-rc.5`，默认关闭所有预设的接管。

## 安装

使用 Node.js 24.9 或更高版本。在有角色预设注册表的 Web profile 中安装打包产物。

```sh
npm ci
npm test
npm run typecheck
npm pack
dsh plugin --profile web add ./dsh-plugin-affection-0.2.0.tgz
```

## 设置 → 情感聊天

1. 选择要编辑的预设，填写人格提示词。文本按字面使用，包括 `{{…}}`。情绪快照由插件独立提供。
2. 勾选本角色允许调用的工具。留空即可纯聊天。模型首步可以请求一批工具，收到结果后生成一次无工具的最终答复。工具审批由宿主处理。
3. 勾选「接管此预设」并保存。新建或重新加载会话时应用接管开关。已接管角色的人格和白名单在下一轮读取。子代理沿用自己的会话行为。
4. 页面下方显示当前好感度与四项驱力。打开页面和可见期间每 5 秒刷新，编辑中的草稿会保留。「暂无情绪档案」表示该角色还没有档案。

人格、白名单和开关保存在 `dsh_affection_settings`。升级自 v0.1.0 时，原 `enabledPresets` 配置停止生效。原 `dsh_affection` 数值档案继续保留，重新启用同一 ID 即可沿用。预设暂时移除或执行情绪重置也会保留人格设置。

## 交互

| 命令 | 效果 |
| --- | --- |
| `/mystatus` | 查看当前角色对你的情绪、自己的状态、数值、基线和已计数的真人轮次 |
| `/set_emotion affection=75 libidoOther=30` | 逐项设值。驱力同时设置当前值与基线，可用字段见下表 |
| `/reset_current` | 四项驱力回到各自基线 |
| `/reset_emotion` | 重建关系与轮数，保留角色自身的两项驱力 |
| `/reset_all_emotions` | 重建当前角色的全部情绪与轮数 |

这些命令属于启用角色的本机聊天界面。输入命令无需调用模型。角色关系和自身状态由 DSH 的 `storageDomain` 保存到 `dsh_affection` 域。情绪上下文由宿主按其常规会话策略记录，插件自己的档案不保存对话原文。

| 配置项 | 默认值及用途 |
| --- | --- |
| `fullAffectionPresets` | 空数组，指定初始好感 100 的角色 |
| `initialAffection` | 50，范围 0～100 |
| `initialDrives` | 四项均为 25，范围 0～50。字段为 `libidoOther`、`aggressionOther`、`libidoSelf`、`aggressionSelf` |
| `sensitivity` | 30，以百分比缩放当前值和好感的对话增量 |
| `lockTurns` | 5，首轮提供快照，每组有效互动共享一份提示 |
| `decayHours` | 2，四项当前值从各自最近的变动时间回归基线 |
| `idleEnabled`、`idleHours` | 默认启用，连续 6 小时空闲后后台评估一次 |
| `analysisRoute` | 省略时沿用聊天模型；自定义时填写 `{ provider, model }` |
| `analysisTimeoutMs` | 30000，后台分析超时后保留已有数值 |

首次真人互动只计数。从第二次起，每个有效轮次额外调用一次分析模型。分析时会发送本轮真人输入、最多 2,000 字符的近期对话及情绪数值。空闲分析使用上次互动的模型路由或显式配置的路由。分析结果通过后续情绪快照影响回复。

## 验证与许可

在安装了目标版本 DSH 的开发机上运行 `pwsh -File tests/run-host.ps1`。设置环境变量 `AFFECTION_BROWSER` 为 Chrome 或 Edge 可执行文件的完整路径，可同时运行隔离 Web profile 中的浏览器设置页验收。

如有 v0.1.0 安装包，传入 `-LegacyPackage ./dsh-plugin-affection-0.1.0.tgz` 可验证真实旧档案的升级。卸载插件后，重新加载已接管的会话，以恢复该预设的工具执行器。

本项目按 [GNU AGPL v3](LICENSE) 分发。
