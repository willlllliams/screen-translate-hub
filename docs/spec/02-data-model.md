# 数据模型

对应需求：[OCR 与竞速翻译](../requirements/03-ocr-and-translation-race.md) 第 2 至 5 节，[运行与生命周期](../requirements/04-run-lifecycle.md) 第 1、3、7 节，[产品需求](../requirements/01-product.md) 第 5、8 节。

本文定义平台内部流转的数据：坐标与几何、画面、文字块、翻译单元、候选、竞速记录、变化图、译文缓存、运行记录、显示事件和历史记录条目。字段记号见 [总览](00-overview.md) 3.2，线路上的编码见 08 服务协议。

## 1 坐标与几何

### 1.1 画面坐标

画面坐标系的原点在画面左上角，x 轴向右，y 轴向下，单位是画面像素。第 $i$ 列、第 $j$ 行的像素占据区域 $[i, i+1) \times [j, j+1)$，宽 $W$、高 $H$ 的画面覆盖 $[0, W) \times [0, H)$。

### 1.2 矩形与四边形

平台使用三种几何类型：

| 类型 | 字段 | 用途 |
| --- | --- | --- |
| `Rect` | `x`、`y`、`w`、`h`，均为 `int32`，`w` 和 `h` 不小于 1 | 像素区域：变化图的分块、送去 OCR 的区域。覆盖 $x \le i < x + w$、$y \le j < y + h$ 的像素 |
| `RectF` | `x`、`y`、`w`、`h`，均为 `float64` | 段落的外接矩形 |
| `Quad` | 四个点，每点为 `x`、`y` 两个 `float64` | 文字块的四边形框，文字倾斜时也能贴合 |

`Quad` 的四个点按屏幕上看到的顺时针方向排列，从 $x + y$ 最小的点开始；两个点的 $x + y$ 相等时，从 $y$ 较小的点开始。各 OCR 引擎给出的点序各不相同，统一点序后，判断上边、下边时不需要再看引擎。

四边形 $q$ 覆盖的像素范围记为 $\operatorname{px}(q)$，取能包住它的最小像素矩形，再裁到画面之内：

$$
\operatorname{px}(q) = \Big[\lfloor x_{\min} \rfloor,\ \lceil x_{\max} \rceil\Big) \times \Big[\lfloor y_{\min} \rfloor,\ \lceil y_{\max} \rceil\Big)
$$

其中 $x_{\min}$、$x_{\max}$、$y_{\min}$、$y_{\max}$ 是四个点坐标的最小值和最大值。段落复用查变化图时用这个像素范围，见 [运行协调器](04-run-coordinator.md) 第 4 节。

### 1.3 相对坐标

显示事件中的位置使用相对坐标，按需求 03 第 3.2 节换算：

$$
\hat{x} = \frac{x}{W}, \qquad \hat{y} = \frac{y}{H}
$$

相对坐标用 `float32` 传输。`float32` 的尾数有 24 位，$[0.5, 1)$ 区间内相邻两个可表示数之差为 $2^{-24} \approx 6.0 \times 10^{-8}$，区间 $[0, 0.5)$ 内更小。宽 7680 像素的 8K 画面上，这个间距对应：

$$
7680 \times 2^{-24} \approx 4.6 \times 10^{-4} \ \text{像素}
$$

远小于一个像素，所以 `float32` 不会让绘制位置产生可见的偏差。

### 1.4 桌面坐标与采集几何

本机覆盖层要把画面上的位置换算到桌面上。两个平台的桌面坐标系不同：

- Windows：虚拟屏幕坐标，单位是物理像素。桌面端声明每显示器 DPI 感知 V2（需求 07 第 2 节），窗口坐标和采集坐标因此都是物理像素；
- macOS：全局显示坐标，单位是点，原点在主显示器左上角，y 轴向下。每块显示器有自己的缩放比例，即每点对应的像素数。

每张画面附带一份采集几何 `CaptureGeometry`，记录画面像素与桌面坐标的对应关系：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `kind` | `enum{display, window, region}` | 采集范围：整块显示器、某个窗口、某个固定区域 |
| `display_id` | `string` | 画面所在显示器的平台标识 |
| `window_id` | `uint64?` | 窗口采集时的窗口标识：Windows 的窗口句柄，macOS 的 `CGWindowID` |
| `origin_x`、`origin_y` | `float64` | 画面像素 $(0, 0)$ 的桌面位置。窗口采集时是相对于窗口外框左上角的偏移 |
| `scale` | `float64` | 每个桌面坐标单位对应的画面像素数。Windows 上为 1，macOS 上为显示器的缩放比例 |
| `width`、`height` | `uint32` | 画面的宽和高，像素 |

画面像素 $(x, y)$ 对应的桌面坐标为：

$$
X = X_0 + \frac{x}{s}, \qquad Y = Y_0 + \frac{y}{s}
$$

其中 $s$ 是 `scale`。整块显示器和固定区域采集时，$(X_0, Y_0)$ 就是 `origin_x`、`origin_y`。窗口采集时：

$$
X_0 = X_w + \mathtt{origin\_x}, \qquad Y_0 = Y_w + \mathtt{origin\_y}
$$

$(X_w, Y_w)$ 是窗口外框此刻的左上角，由窗口跟踪在绘制时提供。窗口移动后只有 $(X_w, Y_w)$ 改变，覆盖层据此重新定位译文，不需要新的批次（需求 01 第 5.2 节）。窗口外框在两个平台上的确切定义见 12 桌面端。

例如，macOS 上一块缩放比例为 2 的显示器，固定区域采集的 `origin` 为 $(100, 50)$ 点。画面像素 $(400, 300)$ 处的文字，桌面坐标为 $(100 + 400/2,\ 50 + 300/2) = (300, 200)$ 点。

## 2 画面

一张画面 `Frame` 包含以下字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `frame_id` | `uint64` | 一次采集会话内从 1 开始递增 |
| `width`、`height` | `uint32` | 像素 |
| `pixel_format` | `enum{bgra8}` | 每像素 4 字节，按 B、G、R、A 排列，行与行之间没有填充 |
| `color_space` | `enum{srgb}` | 采集时统一转换到 sRGB |
| `captured_at` | 墙上时间 | 截屏的时刻 |
| `geometry` | `CaptureGeometry` | 见 1.4 |
| `pixels` | `bytes` | 长度为 $4WH$ |

屏幕画面不透明，A 通道不参与比较、识别和编码。

画面在服务之间传递时编码为 `EncodedImage`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `format` | `enum{raw_bgra8, png, webp_lossless, webp, jpeg}` | 编码格式 |
| `width`、`height` | `uint32` | 像素 |
| `data` | `bytes` | 编码后的数据 |

本机进程之间传递未压缩的 `raw_bgra8`，跨设备传给 OCR 时用无损格式，传给观看分发时用有损格式。各场景的具体选择见 09 服务接口。

## 3 文字块与 OCR 结果

### 3.1 文字块

文字块 `TextBlock` 是 OCR 服务返回的最小单元，对应画面中的一行文字或一行中的一段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `block_id` | `uint32` | 在一次 OCR 结果内唯一 |
| `text` | `string` | 识别出的文字 |
| `quad` | `Quad` | 文字所在的四边形框 |
| `direction` | `enum{ltr, rtl, ttb}?` | 书写方向：横排从左到右、横排从右到左、竖排从上到下。引擎没有提供时缺省，由归一化推断，见 06 归一化第 3 节 |
| `confidence` | `float32?` | 置信度，0 到 1 |
| `language` | `string?` | 引擎识别出的语言 |
| `char_quads` | `list<Quad>?` | 引擎给出字符级框时保留，与 `text` 中的字符一一对应 |

引擎只给出词级或字符级结果时，由这个引擎的 OCR 服务先合并成行，再返回。需求 03 第 3.1 节的"统一数据结构"因此在每个 OCR 服务内部完成：归一化服务只处理统一格式的文字块，不需要认识任何一个引擎的原始格式，新增引擎也不用修改归一化。

### 3.2 OCR 结果

一次 OCR 调用可以处理画面中的多块区域。每块区域单独记录它在画面中的位置和缩放比例，坐标换算由归一化完成（需求 03 第 3.2 节）。

`OcrResult` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `run_id`、`batch_seq` | 标识 | 这次识别所属的批次 |
| `regions` | `list<OcrRegion>` | 每块区域的结果 |

`OcrRegion` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `rect` | `Rect` | 这块区域在画面中的位置，左上角即需求 03 中的 $(o_x, o_y)$ |
| `scale` | `float64` | 送入 OCR 的图片相对于这块区域的缩放比例 $s$ |
| `blocks` | `list<TextBlock>` | 坐标以送入 OCR 的图片为准 |
| `engine` | `string` | 引擎名称和版本 |

## 4 翻译单元

翻译单元 `Unit` 是翻译和 AI 节点处理的对象。屏幕类工作流中，翻译单元就是归一化产出的段落，带有几何信息；划词中只有一个翻译单元，没有几何信息。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `paragraph_id` | `uint32` | 批次内唯一，从 1 开始 |
| `order` | `uint32` | 批次内的阅读顺序，从 1 开始 |
| `text` | `string` | 送去翻译的原文 |
| `language` | `string?` | 段落的语言：OCR 给出时由归一化填写，否则由运行协调器的语言识别填写（[运行协调器](04-run-coordinator.md) 3.4）；都判断不了时缺省 |
| `direction` | `enum{ltr, rtl, ttb}?` | 书写方向，没有几何信息时缺省 |
| `lines` | `list<TextBlock>?` | 段落包含的原始框，画面像素坐标，按阅读顺序排列；没有几何信息时缺省 |
| `bounds` | `RectF?` | 全部原始框的外接矩形，画面像素坐标 |
| `origin` | `enum{recognized, reused, injected}` | 来历：本批次识别得到、从上一批次复用、由界面注入 |
| `reused_from` | `ReuseRef?` | 复用时填写，见下表 |
| `context_text` | `string?` | 交给 AI 时附带的参考内容，例如覆盖层上这一段当前的译文 |

`origin` 为 `injected` 的单元来自用户界面：划词取得的文字，以及用户在覆盖层交互模式中交给 AI 的段落。

`ReuseRef` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `batch_seq` | `uint64` | 上一批次 |
| `paragraph_id` | `uint32` | 段落在上一批次中的标识 |
| `dx`、`dy` | `int32` | 位移，像素；原地未变时为 0 |

复用的段落在新批次中获得新的 `paragraph_id`（需求 04 第 3.5 节），旧标识保存在 `reused_from` 中。

## 5 候选

候选 `Candidate` 是某个翻译源针对某个翻译单元给出的一份译文：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `run_id`、`batch_seq`、`paragraph_id` | 标识 | 候选对应的翻译单元 |
| `source_node` | `string` | 产生候选的翻译节点 |
| `version` | `uint32` | 从 1 开始；同一来源对同一单元每给出一次累计译文，加一 |
| `final` | `bool` | 完成标记 |
| `text` | `string` | 累计译文 |

结束信号单独到达、没有新文字时，运行协调器生成一份 `version` 加一、`final` 为真、`text` 与上一版本相同的候选（需求 03 第 4.2 节）。翻译服务用"回复中不带文字字段"表示这种情况，与"累计译文是空字符串"区分开（[服务接口](09-service-interfaces.md) 第 13 节）。

竞速节点给它的翻译源排出名次 $r(s) \in \{1, 2, \dots, n\}$，名次 1 是首选源。需求 03 第 5.3 节的优先级 $p(s)$ 与名次的关系为：

$$
p(s) = n + 1 - r(s)
$$

名次越小，优先级越高。显示事件用名次标明译文来自哪个源。

## 6 竞速记录

每个批次中，每个段落在每个竞速节点上有一份竞速记录 `RaceRecord`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `race_node` | `string` | 竞速节点 |
| `batch_seq`、`paragraph_id` | 标识 | 段落 |
| `shown` | `enum{none, candidate, error}` | 当前显示：空白、某份候选、错误提示 |
| `shown_candidate` | `ShownRef?` | `shown` 为 `candidate` 时，记录来源、版本和完成标记 |
| `shown_text` | `string?` | `shown` 为 `candidate` 时，当前显示的译文。写入译文缓存和保存历史记录时使用 |
| `sources` | `map<string, SourceOutcome>` | 每个翻译源在这一段上的状态 |
| `end_state` | `enum{complete, partial, provisional, error, aborted}?` | 结束状态，竞速结束后填写 |
| `via` | `enum{race, reuse, cache}` | 结果的来历：经过竞速、复用上一批次、命中译文缓存 |
| `ended_by` | `enum{settled, all_ended, deadline, pause, stop, cancel}?` | 竞速因什么结束 |

结束状态与需求 03 第 5.8 节的名称一一对应：

| 取值 | 需求中的名称 |
| --- | --- |
| `complete` | 完整结果 |
| `partial` | 部分结果 |
| `provisional` | 临时结果 |
| `error` | 错误 |
| `aborted` | 中止 |

`SourceOutcome` 的字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `state` | `enum{queued, running, finished, failed, unavailable, cancelled, pruned}` | 排队、运行中、正常结束、失败、整体不可用、被取消、因无法再影响显示而被提前结束 |
| `has_output` | `bool` | 是否给出过至少一份候选 |
| `last_version` | `uint32` | 最后一份候选的版本，没有候选时为 0 |
| `reason` | `string?` | 失败或取消的原因 |

各字段怎样随事件变化，见 [运行协调器](04-run-coordinator.md) 第 6 节。

## 7 变化图

变化图 `ChangeMap` 描述新画面相对上一批次画面的变化。它把新画面切成边长为 $t$ 像素的方块，记录每一块在哪些位移下与旧画面一致。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `base_frame_id` | `uint64` | 旧画面，即上一个批次的画面 |
| `frame_id` | `uint64` | 新画面 |
| `tile` | `uint32` | 方块边长 $t$，像素 |
| `cols`、`rows` | `uint32` | 方块的列数和行数，$\lceil W/t \rceil$ 和 $\lceil H/t \rceil$ |
| `shifts` | `list<Shift>` | 候选位移，每项为 `dx`、`dy` 两个 `int32`；第 0 项固定为 $(0, 0)$，最多 8 项 |
| `masks` | `bytes` | 每块一个字节，按行存放；第 $k$ 位为 1 表示这一块在第 $k$ 个位移下与旧画面一致 |
| `changed_ratio` | `float32` | 字节为 0 的方块的面积之和占整幅画面面积的比例 |

第 $u$ 列、第 $v$ 行的方块覆盖的像素集合为：

$$
T_{u,v} = \{(x, y) \mid ut \le x < \min((u+1)t, W),\ vt \le y < \min((v+1)t, H)\}
$$

画面的宽或高不是 $t$ 的整数倍时，右边缘或下边缘的方块小于 $t \times t$。

记新画面为 $N$，旧画面为 $O$，第 $k$ 个位移为 $(d_x^k, d_y^k)$，容差为 $\tau$。称方块 $T_{u,v}$ 在第 $k$ 个位移下一致，指对其中每一个像素 $(x, y)$，以下两条同时成立：

1. $(x - d_x^k,\ y - d_y^k)$ 落在旧画面之内；
2. 三个颜色通道都满足 $\lvert N_c(x, y) - O_c(x - d_x^k,\ y - d_y^k) \rvert \le \tau$，$c \in \{R, G, B\}$。

各位的取值：

- 第 0 位对全部方块计算，方块在零位移下一致时为 1，否则为 0；
- 第 $k$ 位（$k \ge 1$）只在 [变化检测](05-change-detection.md) 4.4 节的检验范围内计算，范围内的方块在第 $k$ 个位移下一致时为 1；范围外的方块一律为 0，即使它在这个位移下一致。

所以位为 1 只说明这一块在对应位移下一致，位为 0 不说明不一致。复用判定只用到前一个方向（[运行协调器](04-run-coordinator.md) 4.4），检验范围外的位为 0，只会让少数段落改为重新识别，不会让复用出错。

按这个定义：

- 第 0 位为 1 的方块原地未变，即需求 04 第 3.5 节的"原地未变"；
- 第 $k$ 位（$k \ge 1$）为 1 的方块，其中的内容是旧画面中对应位置平移 $(d_x^k, d_y^k)$ 得到的，即"平移区域"；
- 字节为 0 的方块按"变化区域"处理。

一块纯色背景在任何位移下都一致，位于检验范围内时，它的字节会有多个位为 1。每块记录一组位，用来容纳这种情况：滚动的段落周围常有空白，空白方块同时满足 $(0, 0)$ 和滚动位移；判断段落是否整体平移时，只要求段落覆盖的方块在同一个位移下一致，这些空白方块因此不会妨碍判断。

两张画面的宽或高不同时，变化图只有第 0 个位移，全部字节为 0，`changed_ratio` 为 1，即整张画面视为变化。窗口尺寸改变后的重新排版因此按画面变化处理，与需求 04 第 3.5 节一致。

变化图的大小为 $\lceil W/t \rceil \cdot \lceil H/t \rceil$ 字节。3840×2160 的画面取 $t = 16$ 时为 $240 \times 135 = 32400$ 字节，约 32 KB，是这张画面未压缩数据（$3840 \times 2160 \times 4 \approx 33.2$ MB）的千分之一。$t$ 的取值和计算方法见 05 变化检测。

## 8 译文缓存

译文缓存的每一项以竞速节点和规范化的原文为键：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `race_node` | `string` | 竞速节点 |
| `key_text` | `string` | 原文按下面的规则规范化后的结果 |
| `text` | `string` | 首选源给出的完整译文 |
| `stored_batch_seq` | `uint64` | 写入时的批次 |

原文 $u$ 的规范化 $\kappa(u)$ 依次做三步：

1. 按 NFC 规范化；
2. 把每一段连续的空白字符（Unicode `White_Space` 属性）替换为一个空格 U+0020，去掉首尾的空格；
3. 删除两侧都是汉字、平假名或片假名的空格。

第 3 步处理 OCR 在相邻画面中对同一段中日文本时而插入、时而省略空格的情况：中文和日文的词之间本来没有空格，删掉它不改变原文的意思。韩文用空格分词，第 3 步不涉及谚文。例如：

- `"Hello,\n  world "` 规范化为 `"Hello, world"`；
- `"你好 世界"` 和 `"你好世界"` 规范化为同一个键 `"你好世界"`。

规范化只用于缓存的键，送去翻译的原文保持归一化输出的样子。

## 9 运行、批次与运行详情

### 9.1 运行记录

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `run_id` | UUID | 运行标识 |
| `workflow_id` | UUID | 使用的工作流 |
| `workflow_digest` | `string` | 运行开始时冻结的工作流内容的 SHA-256 摘要 |
| `entry` | `enum{screenshot, continuous, selection, image_dialog, image_hint}` | 入口：单次截图、持续屏幕、划词、图片问 AI 的对话用法、图片问 AI 的鼠标旁提示用法 |
| `device_id` | UUID | 发起运行的电脑 |
| `coordinator_device` | UUID | 运行协调器所在的设备 |
| `state` | `enum{preparing, running, paused, completed, stopped, failed}` | 状态，见 [运行协调器](04-run-coordinator.md) 第 2 节 |
| `started_at`、`ended_at` | 墙上时间 | 后者在运行结束后填写 |
| `pauses` | `list<Pause>` | 每次暂停的时刻、恢复的时刻和原因 |

### 9.2 批次记录

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `batch_seq` | `uint64` | 批次 |
| `frame_id` | `uint64` | 批次画面 |
| `started_at`、`ended_at` | 墙上时间 | 开始与结束 |
| `ended_by` | `enum{settled, deadline, pause, stop}` | 结束原因 |
| `full_reocr` | `bool` | 是否整张重新识别 |
| `ocr_area_ratio` | `float32` | 送去 OCR 的面积占画面的比例 |
| `reused` | `uint32` | 复用的段落数 |
| `cache_hits` | `uint32` | 命中译文缓存的段落数 |

### 9.3 运行详情

运行详情是一串事件，记录用户需要时才查看的失败和处理过程（需求 04 第 7 节）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `at` | 墙上时间 | 发生时刻 |
| `kind` | `enum` | 事件种类，例如请求失败、请求超时、请求取消、源整体不可用、源恢复、重试、段落竞速结束、复用、命中缓存 |
| `batch_seq` | `uint64?` | 所属批次 |
| `node_id` | `string?` | 相关节点 |
| `paragraph_id` | `uint32?` | 相关段落 |
| `service` | `string?` | 相关的服务实例 |
| `reason` | `string?` | 原因说明 |

## 10 显示事件与显示快照

### 10.1 显示流

工作流中的每个显示节点，在一次运行中对应一条显示流。运行协调器把显示内容的每一次变化写成一个显示事件，按顺序发给这条流的所有接收方：本机覆盖层、截图浮卡，或者经观看分发转给各个观看端。

每个事件带有三个公共字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `stream_id` | UUID | 显示流 |
| `seq` | `uint64` | 从 1 开始，每个事件加一 |
| `run_id` | UUID | 所属运行 |

### 10.2 事件种类

| 事件 | 字段 | 含义 |
| --- | --- | --- |
| `run_state` | `state`：`enum{running, paused, stopped}`；`reason`：`string?` | 运行状态变化 |
| `batch_start` | `batch_seq`；`frame`：`FrameRef?`；`geometry`：`CaptureGeometry?`；`carried`：`list<Carry>`；`held`：`list<uint32>` | 切换到新批次。`frame` 只发给网页显示，`geometry` 只发给本机覆盖层 |
| `paragraph_add` | `paragraph_id`、`text`（原文）、`language?`、`direction`、`quads`（相对坐标的四边形列表）、`bounds`（相对坐标的外接矩形）；`takes_over`：`uint32?` | 新出现一个段落 |
| `held_release` | `paragraph_ids`：`list<uint32>` | 撤下这些保留段落 |
| `paragraph_show` | `paragraph_id`；`kind`：`enum{text, error}`；`text?`；`source_rank?`；`version?`；`final?`；`error_reason?` | 段落显示的内容变化 |
| `paragraph_end` | `paragraph_id`、`end_state`、`via` | 段落的竞速结束 |
| `notice` | `notice_id`；`kind`：`enum{preferred_unavailable}`；`race_node`；`reason`；`active`：`bool` | 整体提示出现或撤下 |
| `batch_end` | `batch_seq`、`ended_by` | 批次结束 |

`Carry` 记录一个复用段落：新标识 `paragraph_id`、旧标识 `from_paragraph_id`，以及相对坐标的位移 `dx`、`dy`。复用的段落保留原文、显示内容和结束状态，显示端只把它移到新位置。

`held` 列出上一批次中暂时保留显示的段落，即需求 04 第 3.6 节中位置没有变化、要重新识别的段落，标识是它们在上一批次中的段落标识。显示端把这些段落放进一个单独的保留集合，原样显示，与本批次的段落分开编号，所以两者的标识可以相同。本批次 OCR 完成后，每个保留段落恰好有一个去向：

- 被某个新段落接替：这个新段落的 `paragraph_add` 带有 `takes_over`，值为被接替的保留段落的标识。显示端撤下这个保留段落，新段落沿用它的显示内容，直到新段落自己的 `paragraph_show` 到达；
- 被撤下：它的标识出现在 `held_release` 中。

`FrameRef` 记录批次画面在观看分发中的标识和原始尺寸，观看端按自己的显示尺寸请求合适的分辨率，见 07 显示与排版。

### 10.3 顺序规则

显示事件满足以下顺序：

- 同一条显示流的事件按 `seq` 递增的顺序送达；
- `batch_start` 先于这个批次的其他事件；
- 一个段落的 `paragraph_show` 和 `paragraph_end` 在它的 `paragraph_add` 之后，或者它出现在 `batch_start` 的 `carried` 中之后；
- 收到 `batch_start` 时，上一批次中既不在 `carried`、也不在 `held` 里的段落一律撤下；
- 本批次的 OCR 和归一化完成或失败时，每个保留段落恰好被接替一次或撤下一次，都在 `batch_end` 之前；OCR 失败、本批次没有新段落时，全部保留段落出现在同一个 `held_release` 中；
- 运行在 OCR 完成之前暂停或停止时，保留段落留在冻结的显示中；恢复后下一个批次的 `batch_start` 把它们撤下。

一个命中译文缓存的段落依次产生三个事件：`paragraph_add`；`paragraph_show`，其中 `final` 为真、`source_rank` 为 1；`paragraph_end`，其中 `end_state` 为 `complete`、`via` 为 `cache`。

### 10.4 显示快照

显示快照是一条显示流在某个事件之后的完整状态：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `stream_id` | UUID | 显示流 |
| `seq` | `uint64` | 快照已经包含的最后一个事件 |
| `run_state` | `enum` | 运行状态 |
| `batch_seq` | `uint64` | 当前批次 |
| `frame` | `FrameRef?` | 当前批次画面 |
| `geometry` | `CaptureGeometry?` | 当前批次的采集几何 |
| `paragraphs` | `list<ParagraphView>` | 每个段落的原文、位置、当前显示内容和结束状态 |
| `held` | `list<ParagraphView>` | 当前的保留段落，标识是上一批次的段落标识 |
| `notices` | `list<Notice>` | 当前有效的整体提示 |

快照必须等于把第 1 至第 `seq` 个事件依次作用在空状态上得到的结果。接收方发现序号不连续时，即收到的 `seq` 大于上一个 `seq` 加一，丢弃自己的状态，重新取快照，再接收序号更大的事件。观看端断连重连时使用同一套做法（需求 04 第 8.2 节）。

## 11 历史记录条目

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `entry_id` | UUID | 第 7 版 UUID，按标识排序即按时间排序。由产生记录的一方生成：桌面端的记录由主程序生成，网页对话面板中直接发起的对话由网页端生成 |
| `kind` | `enum{screenshot, selection, conversation, node_output}` | 截图翻译、划词、AI 对话、"保存到历史记录"节点的输出 |
| `created_at` | 墙上时间 | 创建时刻 |
| `device_id` | UUID | 产生这条记录的电脑 |
| `run_id` | UUID? | 产生这条记录的运行 |
| `pinned` | `bool` | 用户标记为保留，容量清理和手动清理时跳过 |
| `size_bytes` | `uint64` | 占用的存储空间 |
| `content` | 按 `kind` 而定 | 见下表 |

| `kind` | `content` 的内容 |
| --- | --- |
| `screenshot` | 截图（无损编码）；每个段落的原文、相对位置、最终显示的译文和结束状态 |
| `selection` | 选中的文字；译文，或者 AI 对话的全部消息 |
| `conversation` | 全部消息，每条消息有角色（用户或 AI）、文字、时刻，以及用户主动发送的图片和文本文件附件。鼠标旁 AI 提示存为一问一答：发给 AI 的画面和提示词作为用户消息，回答作为 AI 消息 |
| `node_output` | 节点标识、数据类型，以及节点收到的数据本身：图片、段落列表、候选、译文或 AI 回答（[工作流定义](03-workflow.md) 第 2 节） |

历史记录在桌面端和后台怎样存放与加密，见 10 后台平台服务和 12 桌面端。
