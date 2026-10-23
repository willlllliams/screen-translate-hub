# AI 助手

对应需求：[第一版范围](../requirements/09-v1-scope.md) 第 4 节。

本文规定 AI 助手的组成和接口：会话、心跳截图、门控、AI 大脑、平台工具、屏幕标注和 AI 悬浮卡片。第一版的实现位置见 [第一版实现](18-v1-implementation.md)。

## 1 结构

AI 助手分两层，规则管"什么时候叫醒 AI"，AI 管"叫醒之后做什么"：

```text
屏幕采集（复用 capture 服务）
  → 心跳样本：画面变化比例、活动窗口、可选的 OCR 摘要
  → 门控：快、本地、便宜，输出"叫醒 / 不叫醒"
       规则门控（默认） | 模型门控（jev 等，可选） | 两者组合
  → AI 大脑：只在门控放行时运行一轮
       通过平台工具：截屏、OCR、读当前译文、画标注、在卡片里说话
  → AI 悬浮卡片和屏幕标注
```

AI 大脑一轮通常要几秒到几十秒。门控把调用限制在值得的时刻；一轮进行中再次被叫醒时，只保留最新的一次，等当前一轮结束后再处理，与持续屏幕的待处理位相同（需求 04 第 3.2 节）。

## 2 会话

一个助手会话从用户给出任务开始，到用户结束为止：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `session_id` | UUID | 会话标识 |
| `task` | `string` | 用户给出的任务或问题，可以为空，表示只陪看 |
| `state` | `enum{idle, watching, thinking, paused, stopped}` | 空闲、观察中、AI 正在运行、暂停、结束 |
| `heartbeat_ms` | `uint32` | 心跳间隔，默认值待定 |
| `range` | `CaptureRange` | 观察范围：整屏、某个窗口或跟随活动窗口 |
| `brain` | `string` | 使用的 AI 大脑，见第 5 节 |
| `gate` | `string` | 使用的门控，见第 4 节 |

用户在卡片中输入的每句话都直接叫醒 AI，不经过门控。会话的全部对话在结束时保存到本机历史记录（需求 01 第 8 节）。

## 3 心跳样本

心跳按间隔截取观察范围，用 [变化检测](05-change-detection.md) 的方法与上一次叫醒时的画面比较，得到样本：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `at` | 墙上时间 | 采样时刻 |
| `changed_ratio` | `float32` | 相对上一次叫醒时画面的变化面积比例 |
| `changed_since_ms` | `uint32` | 画面最近一次变化到现在的时长，用来判断画面是否已经稳定 |
| `active_app` | `string` | 活动窗口所属的程序 |
| `window_title` | `string` | 活动窗口标题 |
| `app_switched` | `bool` | 与上一个样本相比，活动窗口是否换了程序 |
| `ocr_excerpt` | `string?` | 门控需要时附带的 OCR 文字摘要，最多若干字符 |
| `user_idle_ms` | `uint32` | 用户最近一次输入到现在的时长 |

## 4 门控

### 4.1 接口

```ts
interface GateInput {
  sample: HeartbeatSample;
  task: string;
  last_wake_at?: string;       // 上一次叫醒的时刻
  wakes_last_hour: number;
}

interface GateDecision {
  wake: boolean;
  confidence: number;          // 0 到 1
  reason: string;              // 写入运行详情，也显示在卡片的状态行
}

interface Gate {
  readonly name: string;
  decide(input: GateInput, signal: AbortSignal): Promise<GateDecision>;
}
```

### 4.2 规则门控

规则门控按顺序判断，第一条命中的规则决定结果：

1. 会话暂停，或者距上一次叫醒不到最短间隔：不叫醒；
2. 最近一小时的叫醒次数达到上限：不叫醒，卡片提示已达到上限。这一条防止无人看管时持续产生费用（需求 04 第 10 节）；
3. 活动窗口换了程序，并且画面已经稳定：叫醒；
4. 变化面积比例超过阈值，并且画面已经稳定：叫醒；
5. 其他情况不叫醒。

"画面已经稳定"指最近一次变化之后已经过了稳定时长：翻页、切换界面时画面常有过渡动画，过渡期间叫醒 AI，它看到的是半截画面。最短间隔、上限、阈值和稳定时长都是会话参数，默认值待定。

### 4.3 模型门控

模型门控把样本整理成一段文字状态，交给一个快速决策模型，按它给出的概率决定。jev 的接入方式：

- 状态：任务、活动程序、窗口标题、变化摘要和 OCR 摘要，整理成一段文字；
- 问题：一个是非题"用户此刻需要助手看一下屏幕"，得到概率 $p$ 和置信度 $c$；可以另加一个选择题，问画面发生了哪类变化；
- 决策：$c$ 不低于置信度阈值时，按 $p$ 是否超过概率阈值决定；$c$ 低于阈值时，交给规则门控决定；
- 调用时限默认 800 毫秒，超时、出错或者没有配置密钥时，同样交给规则门控。

模型门控只能决定"叫醒或不叫醒"，不生成任何内容，不影响 AI 大脑的回答。

### 4.4 组合门控

组合门控先执行规则门控的第 1、2 条（暂停、间隔、上限），再交给模型门控；模型门控不可用时用规则门控的其余规则。第一版默认使用规则门控。

## 5 AI 大脑

### 5.1 接口

```ts
interface WakeEvent {
  kind: 'user_message' | 'gate' | 'hotkey';
  text?: string;               // 用户输入
  decision?: GateDecision;
  sample?: HeartbeatSample;
}

type BrainEvent =
  | { type: 'status'; text: string }          // 例如"正在看屏幕"
  | { type: 'text_delta'; delta: string }     // AI 的回答，流式
  | { type: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  | { type: 'turn_end'; stop: 'done' | 'error' | 'cancelled'; error?: string };

interface Brain {
  readonly name: string;
  open(task: string, tools: PlatformTool[]): Promise<void>;
  wake(ev: WakeEvent, signal: AbortSignal): AsyncIterable<BrainEvent>;
  close(): Promise<void>;
}
```

### 5.2 实现

| 名称 | 实现 | 用途 |
| --- | --- | --- |
| `pi` | 用 pi 的 Node SDK（`@earendil-works/pi-coding-agent`）在助手服务进程内建立会话；内置工具全部关闭（`tools: []`），平台工具经扩展的 `registerTool` 注册；模型和密钥在设置中配置 | 第一版的主要大脑 |
| `claude-code` | 每轮调用本机 Claude Code 的无头模式（`claude -p`），内置工具全部关闭，平台工具经本服务提供的 MCP 服务器接入 | 本机已登录 Claude Code、没有 API 密钥时用于开发测试 |

两种实现使用同一组平台工具（第 6 节），所以工具只写一份。

## 6 平台工具

平台工具是 AI 能做的全部事情。工具不包含任何鼠标、键盘、文件和命令操作（需求 09 第 4.2 节）。

| 工具 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `screen_capture` | `range?`：`screen`、`window` 或区域；`max_width?` | 图片，以及画面与屏幕坐标的对应关系 | 截取观察范围，不含平台自己的窗口和鼠标指针 |
| `screen_ocr` | `region?` | 段落列表：编号、文字、屏幕坐标的外接矩形 | 对观察范围或其中一块区域做 OCR 和归一化 |
| `translation_state` | 无 | 当前持续屏幕翻译的段落：原文、译文、位置 | 没有持续屏幕运行时返回空 |
| `annotate` | 标注列表，见第 7 节 | 每个标注的编号 | 在屏幕上画标注 |
| `clear_annotations` | `ids?` | 无 | 不给编号时清除本会话的全部标注 |
| `say` | `text`，`mode`：`replace` 或 `append` | 无 | 在 AI 卡片中显示一段话；AI 的普通回答也会流式显示在卡片中 |
| `get_context` | 无 | 任务、活动窗口、最近的门控记录 | |

工具的参数和返回值用 JSON Schema 描述，同一份描述同时生成 pi 的工具定义和 MCP 的工具定义。

## 7 屏幕标注

标注画在本机覆盖层的标注层中，与译文层分开（[显示与排版](07-display.md) 第 2 节）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | 标注编号，由平台生成 |
| `kind` | `enum{box, arrow, bubble, highlight, label}` | 框、箭头、气泡、高亮、文字标签 |
| `rect` | `RectF?` | 框、高亮、标签的位置；屏幕坐标，物理像素 |
| `from`、`to` | `Point?` | 箭头的起点和终点 |
| `point` | `Point?` | 气泡指向的位置 |
| `text` | `string?` | 气泡和标签的文字 |
| `color` | `string?` | 颜色，默认值由平台给出 |
| `ttl_ms` | `uint32?` | 自动消失的时间，缺省时一直显示，直到被清除或会话结束 |
| `anchor` | `enum{screen, window}` | 固定在屏幕上，或者跟随观察范围中的窗口移动 |

标注只画在覆盖层上，鼠标和键盘照常穿透到下面的窗口。观察范围是窗口时，标注跟随窗口移动、随窗口最小化而隐藏，规则与译文相同（需求 01 第 5.2 节）。

## 8 AI 悬浮卡片

- 常驻在屏幕一角，可以拖动，不抢焦点；按"唤起 AI 助手"快捷键时获得键盘焦点，用户输入问题后焦点回到原来的窗口（需求 01 第 5.3 节）；
- 显示会话状态（观察中、思考中、暂停）、AI 的回答（流式）、工具调用的简要进度；
- 提供暂停、恢复、结束和清除标注的按钮；
- 排除在屏幕采集之外，AI 截屏时看不到卡片本身（需求 01 第 5.6 节）。

## 9 接口

AI 助手服务实现 `assistant` 接口 1.0：

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Session` | 双方连续收发 | 主程序打开一个助手会话：发送 `Start`、用户消息、暂停、恢复、结束；服务发回状态、回答片段和工具进度 |
| `Tools` | 一问一答 | 列出平台工具的描述，供 MCP 适配和调试使用 |

本机覆盖层另外实现 `overlay.Annotate`（客户端连续发送）：助手服务发送 `AnnotationSet`、`AnnotationClear` 消息，覆盖层按第 7 节绘制。

## 10 第一版的取值和做法

### 10.1 心跳与门控

- 心跳间隔默认 4 秒。每次心跳经采集服务的 `capture.Grab` 截取观察范围（平台自己的窗口和鼠标指针不在画面中），按 16 像素方块、隔点取样、单通道差超过 24 判断方块是否变化；
- 比较的基准是上一次叫醒时的画面。会话刚开始、或者叫醒发生在第一次心跳之前时还没有基准，这时下一次心跳的画面成为基准，变化比例记为 0。没有这一条时，第一次心跳总是"整屏都变了"，会话一开始就会多叫醒一次；
- 规则门控的默认值：最短间隔 20 秒，每小时最多 30 次，变化比例阈值 0.2，稳定时长 1.5 秒；
- 前台程序名、窗口标题、用户空闲时长由助手服务直接调用 Win32（`GetForegroundWindow`、`QueryFullProcessImageNameW`、`GetLastInputInfo`）取得；前台是平台自己的窗口（例如 AI 卡片正在输入）时，沿用上一次的用户程序；
- 暂停期间心跳停止，门控和快捷键都不会叫醒 AI；用户在卡片里发消息会恢复会话。

### 10.2 jev

jev 通过 `@typesafe-ai/sdk` 的 `systemOne` 调用，一次请求问两个问题：

| 问题 | 类型 | 用途 |
| --- | --- | --- |
| `wake`："用户此刻需要助手看一下屏幕吗" | `noul`（是非题） | 返回"是"的概率 $p$ |
| `change`："画面上发生了什么"：新内容、同样的内容、过渡动画、空闲 | `choice` | 返回所选类别的置信度 $c$ |

是非题只给概率，不给置信度，所以用选择题的置信度判断 jev 是否有把握：$c \ge 0.6$ 时按 $p \ge 0.5$ 决定，否则交给规则门控。调用不重试，时限 800 毫秒。请求只含文字状态（第 4.3 节），不发截图。

### 10.3 大脑

- **claude-code**：每个会话一个常驻的 `claude -p` 进程，输入输出都是 stream-json，所以对话在多次叫醒之间延续；`--tools ""` 关闭全部内置工具，`--strict-mcp-config` 只加载本服务的 MCP 服务器，`--allowedTools mcp__sth` 允许平台工具。MCP 服务器是一个很薄的 stdio 代理（`mcp.ts`），由 Claude Code 启动，把 `tools/list`、`tools/call` 转发给助手服务的 `ListSessionTools`、`CallTool`；会话令牌写在私有临时目录里的 MCP 配置文件中，不出现在命令行上。取消一轮时先发 `interrupt` 控制请求，3 秒内没有结束就结束进程，下一次叫醒时重启；
- **pi**：用 SDK 在助手服务进程内建立会话：`tools` 只列出平台工具的名称（显式白名单，pi 的读写文件和命令工具不会加载），会话放在内存中，模型和密钥放在本应用的数据目录而不是 `~/.pi`；`base_url` 配置时把它写成 pi 的 `models.json` 中的一个 OpenAI 兼容提供方（Ollama、vLLM、代理都可以）；
- 两种大脑用同一段系统提示：只能看、指、说，不能点击、输入、读写文件和执行命令；回答要短；心跳叫醒后没有值得说的就只回一个 "-"，卡片不显示这种回答。

### 10.4 服务方法

除第 9 节外，助手服务在本机端点上另有两个方法，只供 MCP 代理使用：`ListSessionTools {session_id}` 和 `CallTool {session_id, name, args}`。会话暂停或结束时 `CallTool` 返回错误，AI 无法在暂停期间截屏。

`translation_state` 用运行协调器新增的 `coordinator.GetDisplay`：不指定运行时返回最新的、正在进行的持续屏幕运行的覆盖层显示快照，助手把其中的相对位置换算为屏幕坐标。

### 10.5 卡片与标注

- 卡片是不透明的无边框窗口，`focusable: false`，平时不会抢焦点；快捷键先记下当前前台窗口，再让卡片可获得焦点并聚焦输入框；发送消息或按 Esc 后卡片恢复为不可获得焦点，并把前台交还给记下的窗口（这时本进程拥有前台，系统允许）；
- 会话的第一句话同时作为任务；
- 标注第一版只支持 `anchor: screen`；`anchor: window` 留待以后，与覆盖层跟随窗口的做法相同；
- 系统的安全提示（例如防火墙的询问框）位于所有置顶窗口之上，画在它上面的标注会被它挡住。
