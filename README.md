# DSH 情感插件

为指定的 DeepSeek Harness 角色保存与本人的关系及自身心境。新聊天沿用同一预设的状态。首个适配版本是 DSH `0.2.2-rc.5`，使用有角色预设注册表的 profile（例如 web）。默认启用名单为空。

## 安装与启用

在 Node.js 24.9 或更高版本的环境中执行：

```sh
npm ci
npm test
npm run typecheck
npm pack
dsh plugin --profile web add ./dsh-plugin-affection-0.1.0.tgz
```

在对应 profile 的 `cordis.patch.yml` 加入配置，随后重载该 profile。将 `standard` 换成你希望启用的角色预设 ID。

```yaml
- id: affection
  config:
    enabledPresets: [standard]
```

`dsh --profile web --dump-config` 可查看最终生效的插件条目。相同宿主存储域中的同名预设共享档案。子代理跳过情感处理。

装有 DSH 的开发机可运行 `pwsh -File tests/run-host.ps1`。它在项目的临时目录创建独立 profile，从本地 tarball 安装插件，用固定响应模型执行聊天、工具调用、命令与热重载，然后重启并卸载插件。

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
| `enabledPresets`、`fullAffectionPresets` | 均为空数组。前者选择角色，后者指定初始好感 100 的角色 |
| `initialAffection` | 50，范围 0～100 |
| `initialDrives` | 四项均为 25，范围 0～50。字段为 `libidoOther`、`aggressionOther`、`libidoSelf`、`aggressionSelf` |
| `sensitivity` | 30，以百分比缩放当前值和好感的对话增量 |
| `lockTurns` | 5，首轮提供快照，每组有效互动共享一份提示 |
| `decayHours` | 2，四项当前值从各自最近的变动时间回归基线 |
| `idleEnabled`、`idleHours` | 默认启用，连续 6 小时空闲后后台评估一次 |
| `analysisRoute` | 省略时沿用聊天模型；自定义时填写 `{ provider, model }` |
| `analysisTimeoutMs` | 30000，后台分析超时后保留已有数值 |

首次真人互动只计数。从第二次起，每个有效轮次额外调用一次分析模型。分析时会发送本轮真人输入、最多 2,000 字符的近期对话及情绪数值。空闲分析使用上次互动的模型路由或显式配置的路由。分析结果通过后续情绪快照影响回复。

## 来源与许可

情绪表和双驱模型移植自 middcom、dream、deepseek 的 [astrbot_plugin_affection](https://github.com/middcom/astrbot_plugin_affection)。本项目按 [GNU AGPL v3](LICENSE) 分发。
