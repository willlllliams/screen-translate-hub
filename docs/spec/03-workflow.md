# 工作流定义

对应需求：[工作流](../requirements/02-workflow.md) 全文，[运行与生命周期](../requirements/04-run-lifecycle.md) 第 2 节，[OCR 与竞速翻译](../requirements/03-ocr-and-translation-race.md) 第 4.4、5.1 节。

本文规定工作流文件的格式、连线上传递的数据类型、全部节点及其端口、执行位置的写法、校验规则、运行参数和默认模板。需求阶段留到 spec 阶段的"节点清单与连线数据"，由本文第 2、3 节给出结论。

## 1 工作流文件

工作流保存为一个 JSON 文档，字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `format_version` | `uint32` | 文件格式版本，本文定义的是 1 |
| `workflow_id` | UUID | 工作流标识 |
| `revision` | `uint64` | 每保存一次加一，用于发现并发修改 |
| `name` | `string` | 名称 |
| `entry` | `enum{screenshot, continuous, selection, image_dialog, image_hint}` | 这条工作流服务的入口用法，见第 5 节 |
| `coordinator` | `Location` | 运行协调器的位置，只能是 `local` 或 `backend` |
| `parameters` | 对象 | 工作流级的运行参数，见第 7 节 |
| `glossary` | `list<GlossaryItem>` | 术语表，每项为原文、译文和可选的备注 |
| `nodes` | `list<Node>` | 节点 |
| `edges` | `list<Edge>` | 连线 |

术语表直接写在工作流文档里。需求 03 第 4.4 节规定每条工作流带一份术语表，放在同一个文档中，导出和导入时术语表随工作流一起移动，不会丢失。

保存时，存储方检查提交的 `revision` 是否等于已保存的 `revision`。相等则保存并加一；不相等说明别处已经改过，存储方拒绝保存，编辑器提示用户重新载入。网页端和桌面端内嵌的编辑器可能同时打开同一条工作流，这条规则让后保存的一方知道冲突，不会悄悄覆盖对方的修改。

一个节点 `Node` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | 节点标识，格式见 [总览](00-overview.md) 3.3 |
| `type` | `string` | 节点类型，见第 3 节 |
| `binding` | `Binding?` | 处理节点绑定的服务，见第 4 节；浮卡和鼠标旁提示可以只写位置，见 3.4；其他输入、输出和流程节点没有这个字段 |
| `params` | 对象 | 节点参数，内容由节点类型决定 |

一条连线 `Edge` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `from` | `string` | 起点，写作"节点标识.输出端口" |
| `to` | `string` | 终点，写作"节点标识.输入端口" |

一个输出端口可以连出多条连线，把同一份数据同时送往多条后续路径。需求 02 第 3.1 节中的"分支"就是这种连法，文件中不需要单独的分支节点；节点编辑器在一个输出端口连出两条以上连线时，画出分支点，让用户看清数据送往了哪些地方。

## 2 数据类型

每个端口有一种数据类型。下表是全部类型：

| 类型 | 内容 | 在一次运行中出现的次数 |
| --- | --- | --- |
| `Image` | 一张画面：`EncodedImage` 加采集几何 | 一次 |
| `BatchFeed` | 被接受为批次的画面序列，每个批次附带相对上一批次的变化图 | 每个批次一次 |
| `OcrResult` | 文字块，见 [数据模型](02-data-model.md) 3.2 | 每个批次一次 |
| `Units` | 翻译单元列表，见数据模型第 4 节 | 每个批次一次 |
| `Candidates` | 一个翻译源按翻译单元给出的候选流，见数据模型第 5 节 | 每个批次一串 |
| `Translation` | 竞速产出的显示事件流，见数据模型第 10 节 | 整个运行一串 |
| `Reply` | AI 回答：带完成标记的累计文字流，可以接收追问 | 每次提问一串 |

单次截图、划词和图片问 AI 的运行只有一个批次，`batch_seq` 为 1。

连线两端的类型必须相同。两个端口例外，它们接受几种类型中的任意一种：

- OCR 节点的 `image` 端口接受 `Image` 或 `BatchFeed`；
- 保存到历史记录节点的 `input` 端口接受 `Image`、`Units`、`Candidates`、`Translation` 或 `Reply`。

## 3 节点

### 3.1 输入节点

输入节点在发起运行的桌面端上执行，没有 `binding` 字段。

| 类型 | 节点 | 输出端口 | 执行者 |
| --- | --- | --- | --- |
| `screen_input` | 屏幕输入 | `batches`：`BatchFeed` | 屏幕采集服务，含变化检测 |
| `screenshot_input` | 截图输入 | `image`：`Image` | 框选截图服务 |
| `selection_input` | 选中文字输入 | `translate`：`Units`；`ask_ai`：`Units` | 取词服务 |
| `image_input` | 图片输入 | `image`：`Image` | 框选截图服务或屏幕采集服务 |

各节点的参数：

- `screen_input`：触发方式及其参数、变化检测的容差和方块边长，见第 7 节。采集范围和范围方式（固定范围或跟随活动窗口）不是工作流的参数，在运行开始时由用户选定，属于运行开始时固定的配置（需求 04 第 2 节），经 `RunStart` 的触发信息交给运行协调器（[服务接口](09-service-interfaces.md) 第 16 节）。这个节点只在画面发生变化时输出新的批次，每个批次附带相对上一批次的变化图，规则见 [变化检测](05-change-detection.md)；
- `selection_input`：没有参数。用户按"划词翻译"时只有 `translate` 端口输出，按"划词问 AI"时只有 `ask_ai` 端口输出，见 5.2；
- `image_input`：图片来源 `source`，取值为 `screenshot`（框选截图）、`screen`（当前屏幕）或 `mouse_region`（鼠标附近的区域）中的一项或几项；取 `mouse_region` 时另有区域的宽和高，单位为桌面坐标单位。

### 3.2 处理节点

| 类型 | 节点 | 输入端口 | 输出端口 | 执行者 |
| --- | --- | --- | --- | --- |
| `ocr` | OCR | `image`：`Image` 或 `BatchFeed` | `result`：`OcrResult` | 绑定的 OCR 服务 |
| `normalize` | 归一化 | `result`：`OcrResult` | `units`：`Units` | 绑定的归一化服务 |
| `translate` | 翻译 | `units`：`Units` | `candidates`：`Candidates` | 绑定的翻译服务或语言模型服务 |
| `race` | 竞速 | `units`：`Units`；`sources`：`Candidates`，多条 | `translation`：`Translation` | 运行协调器 |
| `llm_chat` | AI 对话 | `units`：`Units` | `reply`：`Reply` | 绑定的语言模型服务 |
| `vision_ai` | 视觉 AI | `image`：`Image` | `reply`：`Reply` | 绑定的视觉模型服务 |
| `http_request` | 自定义 HTTP 接口 | `units`：`Units` | `candidates`：`Candidates` 或 `reply`：`Reply` | 绑定位置上的自定义 HTTP 请求服务 |

各节点的参数：

- `ocr`：识别语言，列表，可以为 `auto`；引擎自己的选项，由服务描述声明。
- `normalize`：没有必填参数。
- `translate`：
  - 语言对，只在这个节点不连向竞速节点时填写；连向竞速节点时使用竞速节点的语言对（需求 01 第 7 节）；
  - 输出方式 `mode`，取 `stream` 或 `complete`，只对绑定语言模型的节点有效；同一个 AI 的流式源和完整源是两个翻译节点（需求 03 第 4.2 节）；
  - 提示词模板，只对绑定语言模型的节点有效，可以引用原文、语言对、术语表和上下文；
  - 上下文选项：是否附带本次运行中最近的若干段原文，以及最多几段，默认关闭（需求 03 第 4.4 节）；
  - 是否使用术语表，默认使用；
  - 每次请求最多包含的段落数，默认取服务声明的上限（需求 03 第 4.3 节）；
  - 节点超时和重试次数。
- `race`：语言对；名次表 `ranking`，按名次从高到低列出连到 `sources` 端口的翻译节点，第一个是首选源。
- `llm_chat`：系统提示词、提示词模板、生成参数（例如最大输出长度）、节点超时；在持续屏幕工作流中另有"只处理新段落"，默认打开，复用的段落不再交给 AI（[运行协调器](04-run-coordinator.md) 3.3）。
- `vision_ai`：系统提示词、默认问题、生成参数、节点超时。用户在对话面板中输入的问题会替换默认问题；鼠标旁提示没有输入框，始终使用默认问题。
- `http_request`：接口形态 `shape`，取 `translate` 或 `reply`，决定输出端口是 `candidates` 还是 `reply`；请求方法、地址、请求头、请求体模板；从响应中取出文字的 JSON 指针（RFC 6901）；节点超时和重试次数。请求头和请求体可以按名称引用凭据，凭据本身保存在执行这个节点的设备上，不写进工作流。

翻译节点和接口形态为 `translate` 的自定义 HTTP 接口节点都输出 `Candidates`，下文统称翻译源节点。连向竞速节点的翻译源节点，是这个竞速的翻译源，由竞速统一调度：只为需要竞速的段落发起请求，复用的段落和命中译文缓存的段落不发给它们，规则见 [运行协调器](04-run-coordinator.md) 第 4、5 节。

### 3.3 流程节点

| 类型 | 节点 | 输入端口 | 输出端口 | 执行者 |
| --- | --- | --- | --- | --- |
| `switch` | 条件分支 | `input`：`Units` | 每个条件一个端口，另有 `else`，类型都是 `Units` | 运行协调器 |

条件分支逐个检查翻译单元，把它送到第一个满足条件的端口，都不满足时送到 `else`。条件有三种：

- 语言属于给定的列表；
- 原文的字符数落在给定的范围内；
- 原文匹配给定的正则表达式。

正则表达式使用不回溯的语法和匹配器，例如 Google 开源的正则表达式库 RE2 支持的语法。回溯式匹配器遇到某些表达式和输入时耗时会随输入长度指数增长，一段识别出的长文字就可能让运行协调器卡住；不回溯的匹配器耗时与输入长度成线性关系。

### 3.4 输出节点

| 类型 | 节点 | 输入端口 | 执行位置 | 执行者 |
| --- | --- | --- | --- | --- |
| `screenshot_card` | 截图浮卡 | `image`：`Image`；`translation`：`Translation` | 发起运行的桌面端，或者开放了卡片显示的其他电脑 | 浮卡与对话面板服务 |
| `selection_card` | 划词浮卡 | `candidates`：`Candidates`，可选；`reply`：`Reply`，可选；至少连一个 | 发起运行的桌面端，或者开放了卡片显示的其他电脑 | 浮卡与对话面板服务 |
| `overlay` | 本机持续翻译覆盖层 | `translation`：`Translation` | 屏幕输入所在的电脑 | 本机覆盖层服务 |
| `web_display` | 网页显示 | `batches`：`BatchFeed`；`translation`：`Translation` | 后台 | 观看分发 |
| `mouse_hint` | 鼠标旁 AI 提示 | `reply`：`Reply` | 发起运行的桌面端，或者开放了 AI 提示的其他电脑 | 鼠标旁提示服务 |
| `desktop_dialog` | 桌面对话面板 | `image`：`Image`，可选；`reply`：`Reply` | 发起运行的桌面端 | 浮卡与对话面板服务 |
| `web_dialog` | 网页对话面板 | `reply`：`Reply` | 后台 | 观看分发 |
| `save_history` | 保存到历史记录 | `input`：见第 2 节 | 发起运行的桌面端 | 主程序的历史记录 |

截图浮卡、划词浮卡和鼠标旁 AI 提示可以带一个只写 `location` 的 `binding`，把结果显示到另一台电脑上，这台电脑必须开放了"卡片显示"或"AI 提示"服务（需求 05 第 3.2 节）。没有 `binding` 时，显示在发起运行的电脑上。

网页显示和网页对话面板由后台的观看分发执行。桌面端独立使用、没有后台时，这两个节点不输出，其余节点照常运行（需求 02 第 2 节）。

追问的规则：

- 显示 `Reply` 的浮卡和对话面板可以追问。追问的问题连同此前的对话，交给产生这个 `Reply` 的 AI 节点，回答作为同一个 `Reply` 端口上的新一串输出；
- 划词浮卡只显示译文时，提供"问 AI"按钮。按下后，以同一段文字触发划词入口的 `ask_ai` 端口，回答显示在同一张浮卡中，见 5.2。

单次截图、划词和图片问 AI 的结果，由主程序按需求 01 第 8 节自动保存，不依赖工作流中有没有保存到历史记录节点。保存到历史记录节点用于保存自动保存之外的内容，例如持续屏幕中某个分支产生的 AI 摘要，存为 `node_output` 类型的条目（[数据模型](02-data-model.md) 第 11 节）。`BatchFeed` 不能连到这个节点，持续屏幕连续采样的画面因此不会进入历史记录（需求 01 第 8 节）。

## 4 执行位置与服务绑定

### 4.1 位置的写法

执行位置 `Location` 有三种写法：

| 写法 | 含义 |
| --- | --- |
| `local` | 发起这次运行的电脑，即需求 02 第 4.1 节的"本机" |
| `backend` | Docker 后台 |
| `device:<设备标识>` | 某一台已经开放了对应服务的电脑 |

`local` 在运行开始时才解析成具体的电脑。同一条工作流在哪台电脑上运行，`local` 就指哪台电脑，所以一份模板可以给所有电脑使用。

### 4.2 绑定

处理节点的 `binding` 有两个字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `location` | `Location` | 执行位置 |
| `service` | `string?` | 该位置上服务的登记名称；缺省表示尚未配置 |

服务的登记名称由服务登记时给出，在同一台设备上唯一（[服务协议](08-service-protocol.md) 8.1），例如 `ocr.ppocr-v6-small`。

两个保留名称让模板在两个平台上通用：

- `bundled.ocr`：这台电脑的桌面端自带的 OCR 引擎；
- `bundled.translate`：这台电脑的桌面端自带的翻译引擎。

Windows 版和 macOS 版自带的引擎可以不同（需求 01 第 2.3 节），保留名称由各自的主程序解析为实际的服务。

竞速和条件分支由运行协调器执行，没有 `binding` 字段。

归一化只有一种实现，每个位置上的归一化服务登记名称固定为 `normalize`。归一化节点可以省略 `binding`，这时与运行协调器放在同一位置（需求 02 第 4.2 节）；也可以只写 `location`，指定放在别处。两种写法都使用该位置上的 `normalize`，不算尚未配置（4.3）。

### 4.3 尚未配置的绑定

默认模板中有些节点出厂时没有可用的服务，例如划词问 AI 和图片问 AI 用到的 AI 节点：桌面端不自带 AI 模型，用户要先配置一个 AI 服务（需求 02 第 2 节）。这些节点的 `service` 缺省，工作流仍然可以保存。

运行时只检查这次实际要执行的节点：按下"划词翻译"时，`ask_ai` 端口下游的 AI 节点不会执行，它没有配置也不影响翻译。实际要执行的节点中有尚未配置的，运行不开始，桌面端提示用户去配置哪一项服务。

## 5 入口

### 5.1 入口用法与绑定

| 入口用法 | `entry` 取值 | 输入节点 | 触发方式 |
| --- | --- | --- | --- |
| 单次截图 | `screenshot` | `screenshot_input` | "截图翻译"快捷键或菜单 |
| 持续屏幕 | `continuous` | `screen_input` | "开始或暂停持续屏幕"快捷键或菜单 |
| 划词 | `selection` | `selection_input` | "划词翻译""划词问 AI"快捷键；选中文字后自动弹出按钮在后续版本加入（需求 01 第 4.3 节） |
| 图片问 AI 的对话用法 | `image_dialog` | `image_input` | 菜单 |
| 图片问 AI 的鼠标旁提示用法 | `image_hint` | `image_input` | "鼠标附近问 AI"快捷键 |

图片问 AI 的两种用法是两个 `entry` 取值，各绑定一条工作流（需求 02 第 1 节）。

每台电脑为每种入口用法绑定一条工作流，绑定关系保存在这台电脑上：不同电脑上自带的引擎和用户配置的服务不同，绑定也就各不相同。工作流本身保存在后台的工作流与配置存储，或者桌面端的本机存储；绑定记录工作流的标识和它所在的存储。绑定的工作流保存在后台时，主程序在连着后台时把它缓存到本机，断开后只读使用缓存的副本（[桌面端](12-desktop.md) 第 6 节）。新安装的桌面端把五种用法分别绑定到第 8 节的默认模板。

### 5.2 划词入口的两个端口

选中文字输入节点有两个输出端口。一次运行中只有一个端口输出：

- "划词翻译"触发 `translate` 端口；
- "划词问 AI"触发 `ask_ai` 端口。

没有收到数据的端口，其下游节点在这次运行中不执行。一个节点只要有一个必需的输入端口没有收到数据，就不执行。

两个界面操作也通过 `ask_ai` 端口发起运行：

- 覆盖层交互模式中，用户把某一段交给 AI（需求 01 第 5.2 节）；
- 划词浮卡上的"问 AI"按钮。

这两种情况下，选中文字输入节点直接输出一个 `origin` 为 `injected` 的翻译单元，取词服务不参与：`text` 是这一段的原文，`context_text` 是它当前的译文。用户在覆盖层上问 AI 时，回答因此能同时看到原文和平台给出的译文。

## 6 校验规则

工作流有两道检查。

### 6.1 两道检查与三个状态

工作流有两道检查，对应需求 04 第 1 节的三个状态：

| 状态 | 条件 |
| --- | --- |
| 编辑中 | 静态校验没有通过 |
| 校验通过 | 静态校验通过 |
| 可运行 | 在某台电脑上发起运行时，运行前检查也通过 |

"可运行"要到运行开始时才能确定：`local` 绑定在哪台电脑上发起就解析到哪台电脑，服务的接口版本也随服务升级而变。保存工作流时，编辑器对后台和其他电脑上的绑定先做一次接口版本检查，把不兼容的服务标出来，提前提示用户（需求 06 第 6 节）；最终以运行前检查为准。

### 6.2 静态校验

静态校验只看工作流文档本身，在保存和导入时执行。

图的结构：

1. 节点标识不重复，连线引用的节点和端口都存在；
2. 连线不构成环；
3. 每个输入端口最多有一条连线，竞速节点的 `sources` 端口除外；必需的输入端口必须有连线；
4. 连线两端的类型符合第 2 节的规则。

入口：

5. 恰好有一个输入节点，它的类型与 `entry` 对应，见 5.1；
6. 从输入节点出发，至少能到达一个输出节点。

位置：

7. `coordinator` 只能是 `local` 或 `backend`；
8. 本机持续翻译覆盖层和网页显示只能出现在持续屏幕工作流中；网页显示的 `batches` 端口必须连到屏幕输入节点的 `batches` 端口；网页显示节点最多一个，一次运行因此最多是一路来源（需求 05 第 4.3 节）。

竞速：

9. 竞速节点只能出现在单次截图和持续屏幕工作流中。划词不使用竞速（需求 03 第 5.1 节），图片问 AI 的输出端只接受 `Reply`，也用不上竞速；
10. 竞速节点的 `units` 端口，与它的每个翻译源节点的 `units` 端口，必须连到同一个输出端口，保证参加竞速的段落集合相同；
11. 名次表 `ranking` 恰好列出连到 `sources` 端口的全部翻译源节点，每个一次；
12. 连向竞速节点的翻译源节点，`candidates` 端口只能再连到保存到历史记录节点；连向竞速节点的翻译节点自身不填语言对；
13. 不连向竞速节点的翻译节点必须填写语言对；
14. 截图浮卡、覆盖层和网页显示的 `translation` 端口，必须全部连到同一个竞速节点的输出。需求 02 第 7 节规定一条工作流在一次运行中只产生一份显示结果，所有显示端看到同一份竞速结果；工作流中另有其他竞速节点时，它们的结果只能送去保存到历史记录。

其他：

15. 条件分支的端口名称不重复，正则表达式符合第 3.3 节规定的语法；
16. 自定义 HTTP 接口节点的地址是完整的 `http` 或 `https` 地址。

### 6.3 运行前检查

运行前检查在每次运行开始时执行，结合服务清单中当时的信息：

1. 把每个 `binding` 解析为具体的服务实例：`local` 解析为发起运行的电脑，保留名称解析为这台电脑自带的引擎；
2. 每个服务实例的类别与节点相符，接口版本满足节点要求，规则见 [总览](00-overview.md) 3.6；
3. 每个翻译源节点都支持它的目标语言：连向竞速的用竞速节点的语言对，其他翻译节点用自己的语言对。源语言为具体语言时，翻译源也要支持这种源语言；源语言为 `auto` 时，每一段的语言按 [运行协调器](04-run-coordinator.md) 3.4 确定，某一段的语言不受支持，只让这一段对这个源失败，不阻止运行开始；
4. 这次要执行的节点都已配置，见 4.3；
5. 自定义 HTTP 接口节点引用的凭据，在执行它的设备上存在。运行协调器调用执行设备上自定义 HTTP 请求服务的 `CheckCredentials` 核对，凭据的内容不离开那台设备（[服务接口](09-service-interfaces.md) 第 15 节）。

任何一条不满足时，运行不开始，桌面端说明是哪个节点、哪一项不满足。

服务已经登记、但此刻连不上时，按节点的种类处理：

- 竞速的翻译源连不上：运行照常开始，这个源从一开始就按整体不可用处理，规则见 [运行协调器](04-run-coordinator.md) 第 6.3 节；
- 其他处理节点连不上：每个输出节点都要经过它才能得到输入时，运行不开始，例如单次截图模板中的 OCR 和归一化，缺了任何一个都产生不了结果；它只在部分分支上时，运行照常开始，这个节点和只依赖它的下游节点按失败结束，记入运行详情，其余分支照常执行（需求 02 第 4.4 节）；
- 网页显示和网页对话面板所在的后台连不上：运行照常开始，这两个节点不输出。

## 7 运行参数

运行参数在运行开始时固定（需求 04 第 2 节）。下表列出全部参数，默认值待定（[总览](00-overview.md) 3.7）。

| 参数 | 所在位置 | 单位 | 取值范围 | 含义 |
| --- | --- | --- | --- | --- |
| `batch_deadline_ms` | 工作流 `parameters` | 毫秒 | 1000 至 120000 | 批次总时限 $T_D$ |
| `full_reocr_ratio` | 工作流 `parameters` | 比例 | 0 至 1 | 变化面积超过这个比例时整张重新识别，记为 $\theta$ |
| `adjacency_px` | 工作流 `parameters` | 像素 | 0 至 200 | 判定段落与变化区域相邻的距离 $\delta$ |
| `ocr_margin_px` | 工作流 `parameters` | 像素 | 0 至 200 | 送去 OCR 的区域向外扩展的边距 $m$ |
| `cache_capacity` | 工作流 `parameters` | 条 | 0 至 100000 | 每个竞速节点的译文缓存容量，0 表示不缓存 |
| `trigger.interval_ms` | `screen_input` | 毫秒 | 100 至 60000 | 定时触发的截屏间隔 $\Delta$ |
| `trigger.events` | `screen_input` | 列表 | 后续版本 | 事件触发的种类：鼠标左键点击、非修饰键、快捷键 |
| `trigger.settle_ms` | `screen_input` | 毫秒 | 0 至 5000 | 事件发生后等待界面稳定的时长（需求 04 第 3.1 节） |
| `tolerance` | `screen_input` | 颜色级差 | 0 至 255 | 像素比对的容差 $\tau$ |
| `tile` | `screen_input` | 像素 | 8、16 或 32 | 变化图的方块边长 $t$ |
| `timeout_ms` | 各处理节点 | 毫秒 | 100 至 600000 | 节点超时 |
| `retries` | 各处理节点 | 次 | 0 至 5 | 自动重试次数，默认 0（需求 04 第 5 节） |

译文缓存在一次运行内有效（需求 04 第 3.5 节），但长时间运行的持续屏幕会不断写入新段落。`cache_capacity` 给缓存设上限，满了以后淘汰最久没有被命中的一项。

## 8 默认模板

桌面端为五种入口用法各提供一个默认模板。模板中的处理节点都绑定在 `local`，运行协调器也在 `local`（需求 02 第 2 节）。

### 8.1 单次截图

```text
screenshot_input.image → ocr.image
ocr.result → normalize.result
normalize.units → translate_local.units
normalize.units → race.units
translate_local.candidates → race.sources
race.translation → screenshot_card.translation
screenshot_input.image → screenshot_card.image
```

`ocr` 绑定 `bundled.ocr`，`translate_local` 绑定 `bundled.translate`；竞速的名次表只有 `translate_local`，它就是首选源。

### 8.2 持续屏幕

持续屏幕模板的完整文件如下，其他模板的写法与它相同：

```json
{
  "format_version": 1,
  "workflow_id": "01927b3e-5a40-7c1e-9f00-000000000002",
  "revision": 1,
  "name": "持续屏幕翻译（默认）",
  "entry": "continuous",
  "coordinator": "local",
  "parameters": {
    "batch_deadline_ms": null,
    "full_reocr_ratio": null,
    "adjacency_px": null,
    "ocr_margin_px": null,
    "cache_capacity": null
  },
  "glossary": [],
  "nodes": [
    { "id": "screen", "type": "screen_input",
      "params": { "trigger": { "interval_ms": null },
                  "tolerance": null, "tile": null } },
    { "id": "ocr", "type": "ocr",
      "binding": { "location": "local", "service": "bundled.ocr" },
      "params": { "languages": ["auto"] } },
    { "id": "normalize", "type": "normalize",
      "params": {} },
    { "id": "translate_local", "type": "translate",
      "binding": { "location": "local", "service": "bundled.translate" },
      "params": {} },
    { "id": "race", "type": "race",
      "params": { "source_language": "auto", "target_language": "zh-Hans",
                  "ranking": ["translate_local"] } },
    { "id": "overlay", "type": "overlay", "params": {} },
    { "id": "web", "type": "web_display", "params": {} }
  ],
  "edges": [
    { "from": "screen.batches", "to": "ocr.image" },
    { "from": "screen.batches", "to": "web.batches" },
    { "from": "ocr.result", "to": "normalize.result" },
    { "from": "normalize.units", "to": "translate_local.units" },
    { "from": "normalize.units", "to": "race.units" },
    { "from": "translate_local.candidates", "to": "race.sources" },
    { "from": "race.translation", "to": "overlay.translation" },
    { "from": "race.translation", "to": "web.translation" }
  ]
}
```

参数中的 `null` 表示使用默认值，默认值确定后由模板填入。目标语言的初始值取桌面端的界面语言，上例中界面语言为简体中文。

网页显示节点在没有后台时不输出（需求 02 第 2 节）；电脑没有开启屏幕共享时，这次运行也不构成来源（需求 05 第 4.3 节）。

### 8.3 划词

```text
selection_input.translate → translate_local.units
translate_local.candidates → selection_card.candidates
selection_input.ask_ai → chat.units
chat.reply → selection_card.reply
```

`translate_local` 绑定 `bundled.translate`，语言对为 `auto` 到界面语言。`chat` 是 AI 对话节点，`service` 缺省，用户配置 AI 服务之前，"划词问 AI"会提示去配置（第 4.3 节）。

### 8.4 图片问 AI 的对话用法

```text
image_input.image → vision.image
image_input.image → dialog.image
vision.reply → dialog.reply
```

`image_input` 的 `source` 为 `screenshot` 和 `screen`，用户发起时二选一。`vision` 是视觉 AI 节点，`service` 缺省。

### 8.5 图片问 AI 的鼠标旁提示用法

```text
image_input.image → vision.image
vision.reply → hint.reply
```

`image_input` 的 `source` 为 `mouse_region`。`vision` 的 `service` 缺省，默认问题要求视觉 AI 用一两句话解释图片中的内容，因为鼠标旁提示只显示简短的回答。

## 9 导出与导入

工作流导出为一个 JSON 文件，扩展名为 `.workflow.json`，内容就是第 1 节的工作流文档，另加一张设备名称表：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `devices` | `map<UUID, string>` | 文档中 `device:` 位置引用的设备标识和它们导出时的名称 |

工作流文档本来就不含凭据：自定义 HTTP 接口节点只按名称引用凭据；AI 服务的凭据保存在服务所在的位置，电脑上的保存在那台电脑上，后台的保存在工作流与配置存储中（[后台平台服务](10-backend.md) 第 7 节）。导出文件因此可以直接分享。

导入时依次检查：

1. `format_version` 是平台支持的版本；
2. 按 6.2 做静态校验；
3. `device:` 位置引用的设备如果不属于这个主人，对应节点的 `service` 改为缺省，导入后由用户重新绑定。设备名称表让用户知道原来绑定的是哪台电脑；
4. 服务注册中能找到的服务，检查接口版本，不兼容的列出来提示用户（需求 02 第 1 节）。

导入的工作流获得新的 `workflow_id`，`revision` 从 1 开始，与已有的工作流互不覆盖。
