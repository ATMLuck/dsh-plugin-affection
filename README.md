# DSH 情感聊天

让 DeepSeek Harness 的角色在不同聊天中延续同一段关系。你可以为每个预设编写人格、指定允许的工具，并在设置页查看角色当前的好感度和四项驱力。插件默认关闭所有预设的接管，只作用于已启用角色的顶层聊天。

## 安装

当前插件版本为 `0.2.0`，适配 DSH `0.2.2-rc.5` 的 Web profile。

### 通过 npm 安装

包名为 `@atmluck/dsh-plugin-affection`。包发布后，可在 DSH 侧栏的「插件 → 添加插件」中输入包名，也可运行以下命令。[npm 包页面](https://www.npmjs.com/package/@atmluck/dsh-plugin-affection)

```sh
dsh plugin --profile web add @atmluck/dsh-plugin-affection
```

也可以在 DSH 标准模式中对模型说「请通过 npm 安装情感聊天插件，包名是 `@atmluck/dsh-plugin-affection`。」通过 npm 安装后，可在 DSH 插件详情的「版本」中检查并安装兼容的更新。

### 从本地安装包安装

在仓库根目录运行以下命令。

```sh
dsh plugin --profile web add ./build/atmluck-dsh-plugin-affection-0.2.0.tgz
```

从源码生成安装包需要 Node.js 24.9 或更高版本。运行以下命令会自动创建 `build/`，生成按插件版本命名的 `.tgz` 文件。该目录已加入 Git 忽略规则。

```sh
npm ci
npm pack
```

## 配置第一个角色

1. 在 DSH 中打开 **设置 → 情感聊天**。选择已有预设，或点击人格提示词旁的 **新建预设** 并输入名称。新预设会出现在 DSH 的预设列表中，插件重载后会恢复。
2. 填写**人格提示词**，例如「你是海岸观测员。说话简短，喜欢用天气和潮汐解释日常见闻。」这段文字会成为该预设的完整系统提示词，`{{…}}` 等文本也按原样传给模型。情绪快照由插件单独注入。
3. 勾选该角色可以调用的工具。留空即可纯聊天。打开**接管此预设**并保存。
4. 新建或重新加载使用该预设的会话。发送一条消息后，回到设置页查看档案。以后修改已接管角色的人格或工具名单，会在下一轮聊天生效。

设置页每 5 秒刷新预设列表和当前情感数值，保留正在编辑的草稿。多个窗口同时修改同一预设时，保存冲突会提示重新载入。切换查看对象不会改变接管开关。

## 聊天与情绪更新

普通聊天只生成一次主回复。如果模型需要工具，它可以在首步请求一批已勾选的工具，由 DSH 处理审批和执行，再根据结果生成一次无工具的最终答复。

每个预设有独立的情绪档案，同一存储范围内的多个聊天共享这份档案。默认好感度为 50（范围 0～100），对用户和对自身的两组驱力各有力比多、攻击性两项，默认均为 25（范围 0～50）。

首次真人互动只计数。从第二次起，插件在后台将本轮输入、最多 2,000 字符的近期对话和情绪快照交给分析模型。分析失败时保留原数值。默认每 5 个有效互动轮刷新一次注入的情绪提示，四项当前驱力在 2 小时内逐渐回到各自基线。连续空闲 6 小时后评估一次。

## 查看与调整情感数值

在「设置 → 情感聊天」选择预设。表格显示好感度、四项驱力的当前值和驱力基线。表格上方显示对你的情感、自身状态和互动轮数。

打开表格下方的 **允许编辑情感数值**，可直接修改当前值。点击 **保存情感数值** 后，四项驱力继续从新数值向各自基线回归。基线列只读，好感度没有基线。

编辑模式也提供三项重置操作：

| 操作 | 效果 |
| --- | --- |
| 当前驱力恢复到基线 | 四项驱力回到各自基线 |
| 重置关系与互动轮数 | 恢复初始好感度和对用户的驱力，保留自身的两项驱力 |
| 重置全部情绪与互动轮数 | 恢复全部初始数值，保留人格和工具设置 |

## 高级配置

以下选项属于 DSH profile 中 ID 为 `affection` 的插件配置，对该实例管理的角色生效。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `initialAffection`、`fullAffectionPresets` | `50`、`[]` | 初始好感度；名单中的预设从满好感 100 开始 |
| `initialDrives` | 四项均为 `25` | 设置四项驱力的初始值与基线。字段为 `libidoOther`、`aggressionOther`、`libidoSelf`、`aggressionSelf` |
| `sensitivity` | `30` | 按百分比调整互动对当前驱力和好感度的影响 |
| `lockTurns`、`decayHours` | `5`、`2` | 同一情绪提示覆盖的互动轮数，以及当前驱力回到基线的小时数 |
| `idleEnabled`、`idleHours` | `true`、`6` | 是否评估空闲状态，以及触发所需的连续空闲小时数 |
| `analysisRoute` | 跟随会话模型 | 指定分析用的 `provider` 和 `model` |
| `analysisTimeoutMs` | `30000` | 后台分析的超时时间，单位为毫秒 |

## 升级与卸载

从原先的不带作用域的包升级时，在同一个 profile 中移除旧包，再安装 `@atmluck/dsh-plugin-affection`。两版使用相同的数据存储，切换后可沿用人格、工具设置和情绪档案。

```sh
dsh plugin --profile web remove dsh-plugin-affection
dsh plugin --profile web add @atmluck/dsh-plugin-affection
```


从 v0.1.0 升级会保留 `dsh_affection` 中的好感度、驱力、基线和轮次。旧配置 `enabledPresets` 已停用，需要在设置页为原预设填写人格并重新启用接管。人格、工具名单和开关单独保存在 `dsh_affection_settings` 中。

卸载后，重新加载已接管的会话即可恢复原预设的工具执行器。

```sh
dsh plugin --profile web remove @atmluck/dsh-plugin-affection
```

## 开发验证

```sh
npm test
npm run typecheck
```

安装了目标版本 DSH 的开发机可运行 `pwsh -File tests/run-host.ps1`，在隔离的 Web profile 中验证安装、聊天、重启与卸载。设置环境变量 `AFFECTION_BROWSER` 为 Chrome 或 Edge 的可执行文件路径，可以同时验证设置页。若保留了旧安装包，可执行升级测试：

```powershell
pwsh -File tests/run-host.ps1 -LegacyPackage ./build/dsh-plugin-affection-0.1.0.tgz
```

本项目使用 [GNU AGPL v3 许可证](LICENSE)。
