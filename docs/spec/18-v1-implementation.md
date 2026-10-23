# 第一版实现（Windows）

对应需求：[第一版范围](../requirements/09-v1-scope.md)。

本文规定第一版的进程划分、代码仓库结构、服务协议的第一版承载方式，以及每个模块的职责和主要函数。01 至 16 中的数据结构、算法和接口照常适用；本文只写第一版在实现上的选择，以及函数一级的划分。代码与本文不一致时，以修订本文为先。

## 1 技术选型

| 部分 | 语言与主要依赖 | 理由 |
| --- | --- | --- |
| 桌面主程序：托盘、快捷键、框选、覆盖层、浮卡、AI 卡片、服务监管 | TypeScript，Electron；Win32 接口经 koffi 调用 | 窗口、托盘、快捷键、设置页现成；不需要本机编译器；界面与网页观看端共用排版代码。覆盖层不用 Electron 的透明窗口（没有 GPU 合成时不显示，见第 15.1 节），改为离屏渲染的页面加原生分层窗口 |
| 屏幕采集与变化检测 | Python 3.12，windows-capture（Windows.Graphics.Capture），numpy | 能关闭鼠标指针和采集黄框；Chromium 系的采集做不到不带指针；numpy 做逐像素比对足够快 |
| OCR | Python，RapidOCR 3.10（PP-OCRv6 small），onnxruntime | 实测整屏约 0.8 秒；检测后处理和模型都现成 |
| 运行协调器、归一化、翻译适配、局域网观看、AI 助手 | TypeScript，Node 24 | 竞速、复用和生命周期是事件驱动的状态机，适合单线程事件循环；pi 是 TypeScript 写的；Bergamot 有 WASM 版本 |
| 网页观看端 | TypeScript，浏览器原生 DOM | 与覆盖层共用 `@sth/render` |
| 服务协议 | 第 3 节，WebSocket + MessagePack | Node 和 Python 都有成熟实现；流、时限、取消、状态码的语义与 [服务协议](08-service-protocol.md) 相同 |

第一版的第三方依赖与许可（项目本身是 AGPL-3.0 加商业许可双授权，见 [技术选型](15-tech-selection.md) 第 1 节的许可规则）：

| 依赖 | 版本 | 许可 | 用在 |
| --- | --- | --- | --- |
| Electron | 45 | MIT | 桌面主程序 |
| koffi | 3.3 | MIT | Win32 调用 |
| ws、@msgpack/msgpack | 8.22、3.1 | MIT、ISC | 服务协议 |
| sharp（含 libvips） | 0.35 | Apache-2.0；libvips 为 LGPL-3.0，动态链接 | 观看服务的画面编码、AI 截屏 |
| esbuild | 0.28 | MIT | 构建、观看页打包 |
| @earendil-works/pi-coding-agent、typebox | 1.3、1.3 | MIT | pi 大脑、工具定义 |
| @typesafe-ai/sdk | 0.7 | MIT | jev 门控 |
| Bergamot 胶水代码（vendor） | v0.6.0 | MPL-2.0，按文件保留许可声明 | Bergamot 翻译源 |
| Bergamot 引擎与 Firefox 翻译模型 | 运行时下载 | 随 Mozilla 的发布条款；不随本软件分发 | Bergamot 翻译源 |
| windows-capture、RapidOCR、onnxruntime、OpenCV、numpy | 2.0、3.10、1.31、5.0、2.5 | MIT、Apache-2.0、MIT、Apache-2.0、BSD-3-Clause | 采集、OCR |
| websockets、msgpack（Python） | 17.3、1.2 | BSD-3-Clause、Apache-2.0 | 服务协议 |

都是宽松许可或文件级的弱著佐权许可，可以同时以 AGPL-3.0 和商业许可发布本项目。

原技术选型（[技术选型](15-tech-selection.md)）中的 Rust、Tauri 方案保留为后续路线：协议与语言无关，任何一个服务都可以单独用 Rust 重写后替换，其他服务不受影响。第一版先用开发最快、在这台电脑上就能完整测试的组合。

## 2 进程

第一版的全部进程运行在同一台电脑上：

| 进程 | 登记名称 | 实现的接口 | 语言 |
| --- | --- | --- | --- |
| 桌面主程序 | `agent`、`overlay`、`card`、`region_select`、`window_tracker` | `agent`、`overlay`、`card`、`region_select`、`window_tracker` | TS（Electron） |
| 运行协调器 | `coordinator` | `coordinator` | TS |
| 屏幕采集 | `capture` | `capture` | Python |
| OCR | `ocr.rapidocr` | `ocr` | Python |
| 归一化 | `normalize` | `normalize` | TS |
| 翻译 | 每个翻译源一个进程，例如 `translate.claude-cli`、`translate.openai`、`translate.bergamot`、`translate.mock` | `translate` | TS |
| 局域网观看 | `viewer` | `viewer`，另有 HTTP 和浏览器用的 WebSocket | TS |
| AI 助手 | `assistant` | `assistant` | TS |

主程序是服务清单和监管者（[架构](01-architecture.md) 2.1）：按需启动服务进程，崩溃后按退避间隔重启。系统集成服务都在主程序进程内，与 [桌面端](12-desktop.md) 1.1 一致；屏幕采集是例外，它在单独的 Python 进程中运行。Windows 的屏幕采集不需要系统授权，`WDA_EXCLUDEFROMCAPTURE` 对所有采集方生效，单独成进程不影响权限归属和自身窗口的排除，[桌面端](12-desktop.md) 1.1 的理由只对 macOS 成立。

没有图形界面时（例如经 SSH 运行测试），主程序的核心以无界面方式运行：主程序核心在 `packages/agent-core`，与 Electron 无关，`tools/dev/e2e.ts` 加载同一套服务清单和监管逻辑，用回放采集代替屏幕采集，用记录显示端代替覆盖层（[验收与测试](16-acceptance.md) 第 2 节）。

### 2.1 启动与登记

1. 主程序生成 256 位的本机会话令牌，在 `127.0.0.1` 的随机端口上启动协议服务器；
2. 启动服务进程时，经标准输入写入一行 JSON：`{"agent": "ws://127.0.0.1:端口", "token": "…", "name": "登记名称", "config": {…}}`（[安全](11-security.md) 第 5 节）；
3. 服务在 `127.0.0.1` 的随机端口上启动自己的协议服务器，连上主程序，用 `agent.Register` 登记描述和端点，并保持这条流；
4. 运行协调器用 `agent.ListServices` 解析绑定，用 `agent.Acquire` 占用服务、取得端点后直接连接（[服务协议](08-service-protocol.md) 8.3）。

本机连接都要出示会话令牌。第一版用回环地址上的 TCP 端口代替命名管道：[安全](11-security.md) 第 5 节担心的两个问题，其他系统账户和网页都拿不到令牌，握手不能通过；浏览器的连接另外检查 `Origin`。命名管道作为以后的传输方式，协议层不需要改动。

## 3 服务协议的第一版承载

帧的语义、流、时限、取消、状态码与 [服务协议](08-service-protocol.md) 相同，承载方式简化如下：

- 传输：WebSocket，一个二进制消息承载一个帧；
- 编码：帧和业务消息都用 MessagePack，二进制字段直接使用 MessagePack 的二进制类型；字段名使用 [数据模型](02-data-model.md) 的蛇形命名；
- 不拆分业务消息：单条消息上限 64 MiB，足够容纳未压缩的 4K 画面；
- 流量控制按消息条数计额度：每条流每个方向初始 32 条，接收方的业务代码每取走一条，补回一条。语义与服务协议第 5 节相同：慢的接收方能让发送方停下。

| 帧 | 字段 |
| --- | --- |
| `hello` | `ver`（`[1, 0]`）、`kind`（`local`、`browser`）、`peer`、`token` |
| `ack` | `ok`、`code?`（`INVALID_CREDENTIAL`、`PROTOCOL_INCOMPATIBLE`、`UNAVAILABLE`）、`reason?` |
| `open` | `s`（流标识）、`svc`（目标服务的登记名称）、`iface`、`maj`、`min`、`method`、`dl`（剩余时长，毫秒，0 为不限）、`meta` |
| `msg` | `s`、`b`（业务消息） |
| `half` | `s` |
| `close` | `s`、`code`、`msg?`、`retry?` |
| `cancel` | `s`、`reason` |
| `credit` | `s`、`n` |
| `ping`、`pong` | `n` |

一个进程可以在同一个端点上提供多项服务，`open` 中的 `svc` 选择其中一项，例如主程序同时提供 `agent`、`overlay`、`card`。

## 4 代码仓库结构

```text
package.json                 npm 工作区
tsconfig.base.json
packages/
  wire/                      服务协议（TS）
  model/                     数据模型类型与几何、语言等工具函数（TS）
  render/                    显示状态机、译文排版、DOM 绘制（TS，覆盖层、浮卡、网页共用）
  workflow/                  工作流文档、静态校验、默认模板（TS）
  service-kit/               服务进程的公共启动代码：读启动信息、登记、日志（TS）
  agent-core/                主程序核心：服务清单、监管、agent 接口、发起运行（TS，与 Electron 无关）
services/
  coordinator/               运行协调器（TS）
  normalize/                 归一化（TS）
  translate/                 翻译适配：claude-cli、openai、anthropic、bergamot、mock（TS）
  viewer/                    局域网观看：服务、HTTP、网页（TS）
  assistant/                 AI 助手：门控、心跳、大脑、平台工具、MCP 适配（TS）
  py/
    sth_wire/                服务协议（Python）
    sth_service/             服务进程的公共启动代码（Python）
    capture/                 屏幕采集与变化检测（Python）
    ocr/                     OCR（Python）
apps/
  desktop/                   Electron 主程序：主进程与各窗口的页面
tools/
  dev/                       无界面主程序、回放采集、端到端演示脚本
  win/                       Windows 开发辅助，例如把命令投送到桌面会话
tests/
  fixtures/                  静态样本和动态样本
docs/
```

TypeScript 只使用可擦除的语法（`erasableSyntaxOnly`），Node 24 可以直接运行源文件；发行时用 esbuild 打包。测试用 Node 自带的 `node:test` 和 Python 的 `unittest`，不引入额外的测试框架。

## 5 packages/wire

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `frames.ts` | `type Frame`；`encodeFrame(f: Frame): Uint8Array`；`decodeFrame(b: Uint8Array): Frame` | 第 3 节的帧 |
| `status.ts` | `type StatusCode`；`class RpcError extends Error { code; retryAfterMs? }`；`failureClass(code): 'whole' \| 'segment' \| null` | 状态码与 [运行协调器](04-run-coordinator.md) 6.3 的两类失败 |
| `stream.ts` | `class Stream<In, Out>`：`send(m: Out): Promise<void>`、`recv(): Promise<In \| undefined>`、`[Symbol.asyncIterator]()`、`halfClose()`、`cancel(reason)`、`close(status)`、`done: Promise<Status>`、`signal: AbortSignal`、`deadline?: number` | 一次调用；`send` 在额度不足时等待；时限到达时以 `deadline_exceeded` 结束 |
| `connection.ts` | `class Connection`：`open(svc, iface, ver, method, opts): Stream`、`onOpen(handler)`、`close(reason)`、`closed: Promise<void>` | 多路复用、流标识分配、额度、保活；连接断开时以 `unavailable` 结束其上全部流 |
| `ws.ts` | `connect(url, auth): Promise<Connection>`；`listen(opts: {host, port, token, origins?, onConnection}): Promise<Server>` | WebSocket 传输与握手 |
| `host.ts` | `class ServiceHost`：`constructor(name, manifest)`、`implement(iface, ver, methods: Record<string, Handler>)`、`attach(conn)`；`type Handler = (call: Stream, open: OpenInfo) => Promise<void>` | 服务端：按 `svc`、`iface`、`method` 分派，检查接口版本 |
| `client.ts` | `class Peer`：`unary(svc, iface, method, req, opts)`、`serverStream(...)`、`clientStream(...)`、`bidi(...)` | 四种调用形态的便捷封装 |

Python 的 `services/py/sth_wire` 提供同名的 `Connection`、`Stream`、`ServiceHost`、`Peer`，基于 asyncio 和 websockets，语义相同。

## 6 packages/model

| 文件 | 内容 |
| --- | --- |
| `types.ts` | [数据模型](02-data-model.md) 全部类型：`Rect`、`RectF`、`Quad`、`CaptureGeometry`、`EncodedImage`、`Image`、`TextBlock`、`OcrRegion`、`OcrResult`、`Unit`、`ReuseRef`、`Candidate`、`RaceRecord`、`SourceOutcome`、`ChangeMap`、`DisplayEvent`、`DisplaySnapshot`、`ParagraphView`、`Notice`、`Annotation` |
| `geometry.ts` | `quadBounds(q): RectF`；`pxRect(q, W, H): Rect`（数据模型 1.2 的 $\operatorname{px}$）；`orderQuad(points): Quad`（数据模型 1.2 的点序）；`iou(a, b)`；`rectUnion`、`rectIntersect`、`expandRect`、`clipRect`；`toRelative(q, W, H)` |
| `lang.ts` | `normalizeTag(t)`；`supports(declared: string[], tag): boolean`（[总览](00-overview.md) 3.5 的查找规则）；`sameLanguage(a, b): boolean`（需求 09 第 3.2 节） |
| `text.ts` | `cacheKey(u: string): string`（数据模型第 8 节的 $\kappa$）；`hasWords(text)`（需求 09 第 3.2 节的"没有可译的词"）；`isCjk(ch)`、`scriptOf(ch)`、`scriptHistogram(text)` |

## 7 packages/render

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `state.ts` | `interface DisplayState`；`emptyState()`；`applyEvent(s, ev): ApplyResult`（序号连续时更新，不连续时返回 `gap`）；`fromSnapshot(snap)`；`toSnapshot(s)` | [显示与排版](07-display.md) 第 1 节的显示状态；运行协调器用同一份代码生成快照，保证"快照等于事件依次作用的结果" |
| `layout.ts` | `fitText(input): FitResult`；`wrap(text, px, width, measure)`；`breakPieces(text)`；`expandBox(box, input, gap)` | 07 第 5.3、5.4 节：二分查找字号、占用相邻空白、截断；换行按简化的 UAX #14，中日文避头尾（闭合标点不放行首，开引号不放行尾） |
| `dom.ts` | `class DomRenderer`：`constructor(root, settings)`、`setSettings(s)`、`render(state, {width, height, targetLanguage})`、`hit(x, y)` | 原位底板和整屏压暗两种显示方式（需求 09 第 3.1 节）；根元素按视图尺寸定宽高；译文与原文只差空白时不画；`hit` 供交互模式取悬停段落的原文和译文 |
| `annotations.ts` | `class AnnotationLayer`：`set(items)`、`clear(ids?)`、`render(viewMapping)` | [AI 助手](17-assistant.md) 第 7 节的屏幕标注 |
| `settings.ts` | `interface DisplaySettings`；`defaultSettings(kind)` | 07 第 6 节，加上显示方式和底板不透明度 |

## 8 services/coordinator

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `main.ts` | `main()` | 读启动信息，提供 `coordinator.Run`、`coordinator.GetRunDetails` |
| `run.ts` | `class Run`：`prepare(): Promise<PreflightResult>`、`execute()`、`pause(reason)`、`resume()`、`stop(reason)`、`control(action)` | [运行协调器](04-run-coordinator.md) 第 2、8、9 节的状态机和控制；共享开着时把网页显示发布到观看服务，观看服务重启后用同一来源编号重新发布 |
| `plan.ts` | `compilePlan(doc, entry, resolver): Promise<ExecPlan>` | 冻结配置、解析绑定、运行前检查（[工作流定义](03-workflow.md) 6.3）；把工作流编译成执行计划 |
| `continuous.ts` | `runContinuous(run, plan)` | 04 第 3.1 节的取批次循环 |
| `batch.ts` | `processBatch(ctx, batch): Promise<BatchRecord>` | 04 第 3.2 节的一个批次 |
| `reuse.ts` | `planReuse(prev, map, frame, params, ocrDone): ReusePlan`；`paragraphShift(lines, map)`；`adjacent(rects, map, delta)`；`ocrRegions(map, positions, margin, frame)`；`dropDuplicates(result, reusedBounds)`；`matchHeld(held, units, cacheHas)` | 04 第 4 节的段落复用 |
| `cache.ts` | `class TranslationCache`：`get(key)`、`put(key, text)`、`clear()` | 04 第 5 节，最久未用淘汰 |
| `race.ts` | `class Race`：`onCandidate(c)`、`onFailure(source, cls, reason, cause?)`、`canAffect(source)`、`finish(by)`、`record()` | 04 第 6 节的竞速算法 |
| `dispatch.ts` | `class SourceDispatcher`：`dispatch(units, races, deadline)`；`class ServiceQueue`：`acquire(signal)` | 04 第 7 节：分组、排队、限速、释放与取消 |
| `availability.ts` | `class Availability`：`isUnavailable(svc)`、`mark(svc, code, retryAfter?)`、`onChange(cb)` | 04 第 6.3 节的服务可用状态 |
| `langid.ts` | `detectLanguage(text): string \| undefined` | 04 第 3.4 节；第一版按文字系统判断，可以替换为语言识别库 |
| `display.ts` | `class DisplayHub`：`open(outputs)`、`emit(body)`、`snapshot(stream)` | 为每个显示节点维护显示流，发给覆盖层、浮卡和观看服务 |
| `details.ts` | `class RunDetails`：`push(ev)`、`list(filter)` | 04 第 1 节的运行详情 |

## 9 services/normalize

| 文件 | 函数 | 职责 |
| --- | --- | --- |
| `normalize.ts` | `normalize(req: NormalizeRequest): Unit[]` | [归一化](06-normalization.md) 全部步骤 |
| `coords.ts` | `toFrameCoords(region, block): TextBlock` | 06 第 2 节 |
| `direction.ts` | `inferDirection(block): Direction` | 06 第 3 节 |
| `lines.ts` | `mergeFragments(blocks): Line[]` | 06 第 4 节 |
| `order.ts` | `readingOrder(items, gMin): Item[]`；`leafOrder(items, dir)` | 06 第 5 节的递归切分 |
| `paragraphs.ts` | `mergeParagraphs(items, params): Paragraph[]`；`shouldMerge(a, b, colWidth, params, usualGap, typicalGlyph)` | 06 第 6 节、第 6.1 节 |
| `join.ts` | `joinLines(a, b): string` | 06 第 7 节 |

## 10 services/translate

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `engine.ts` | `interface TranslateEngine { manifest(); translate(req, emit, signal) }` | 一个翻译源的统一形态 |
| `service.ts` | `serveEngine(engine)` | 把引擎包装成 `translate.Translate`（[服务接口](09-service-interfaces.md) 第 13 节） |
| `prompt.ts` | `buildPrompt(req): {system, user}`；`parseItems(text): Map<number, string>` | AI 类翻译源共用的提示词和结果解析，带术语表和上下文 |
| `claude-cli.ts` | `class ClaudeCliEngine` | 常驻一个 `claude -p --input-format stream-json --output-format stream-json` 进程，省去每次启动的开销；内置工具全部关闭 |
| `openai.ts` | `class OpenAiEngine` | 兼容 OpenAI 聊天补全接口，支持流式 |
| `anthropic.ts` | `class AnthropicEngine` | Anthropic Messages 接口，支持流式 |
| `bergamot.ts` | `class BergamotEngine`：`create(config)`、`route(from, to)`、`prepare(from, to)`；`cjkPunctuation(text)` | Bergamot：Firefox 的翻译引擎和模型；没有直达模型时经英文转译 |
| `bergamot/registry.ts` | `class ModelRegistry`：`records(collection)`、`file(record)`；`pickModelFiles()`、`pickWasm()`、`directions()`、`filterApplies()` | 从 Mozilla Remote Settings 选择并下载模型和引擎文件 |
| `bergamot/worker.ts` | worker 线程 | 加载 WASM 引擎和模型，按批翻译 |
| `mock.ts` | `class MockEngine` | 按脚本给出版本、完成标记、延迟和两类失败 |

### 10.1 Bergamot

- **文件来源**：与 Firefox 相同，读 Remote Settings 的 `translations-models` 和 `translations-wasm` 两个集合（`https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/…/records`），附件从服务器声明的附件地址下载，按记录中的 SHA-256 校验，存在 `%APPDATA%\screen-translate-hub\bergamot`。记录列表缓存一天，离线时用旧缓存；
- **选文件**：`filter_expression` 按桌面正式版评估（只出现过 `env.appinfo.OS`、`env.channel` 的比较）；跳过 `2.0a1` 这样的预发布版本；同一方向取版本最新、文件齐全（模型，词表或源、目标两个词表，可选的短名单）的一组；
- **引擎**：Firefox 源码中的 Emscripten 胶水代码（mozilla/translations v0.6.0，MPL-2.0）原样放在 `services/translate/vendor/bergamot/`，配主版本 3 的 WASM。翻译是同步的、占 CPU，所以放在 worker 线程中，服务的事件循环和保活不受影响。模型配置与 Firefox 相同（beam 1、int8 矩阵乘、关闭质量模型）；
- **语言**：清单中的源语言是有"X→英文"模型的语言加英文，目标语言是有"英文→X"模型的语言加英文；两种外语之间经英文转译（`translateViaPivoting`）。不自己判断源语言，由运行协调器的语言识别给出；
- **第一次使用**：某个方向的文件不在本地时，后台开始下载，这一次请求以 `unavailable` 失败并带 30 秒的重试时间，运行协调器把它记为暂时不可用，其他翻译源照常（[运行协调器](04-run-coordinator.md) 6.3）。设置了目标语言时，服务启动就预先下载"英文→目标语言"；
- **译文整理**：中文、日文模型常在汉字之间输出半角逗号、冒号等，替换为全角。

## 11 services/py/capture

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `service.py` | `main()` | 提供 `capture.Session`、`capture.Grab`（[服务接口](09-service-interfaces.md) 第 4 节） |
| `session.py` | `class CaptureSession`：`on_frame(frame, geom)`、`take_batch(wait_ms)`、`pause()`、`resume()`、`close()` | [变化检测](05-change-detection.md) 第 1 至 3 节 |
| `change.py` | `differs(a, b, tol)`；`change_map(new, old, tol, tile)`；`zero_bits(...)`；`components8(mask)`；`estimate_shift(new, old, box, axis)`；`verify_shift(...)` | 05 第 4 节，纯 numpy，与采集方式无关，回放采集也用它 |
| `sources.py` | `class WgcSource`、`class ReplaySource` | 屏幕帧的来源：Windows.Graphics.Capture，或者从文件回放 |
| `geometry.py` | `capture_geometry(range, monitors, window_rect)` | [数据模型](02-data-model.md) 1.4 的采集几何 |

## 12 services/py/ocr

| 文件 | 函数 | 职责 |
| --- | --- | --- |
| `service.py` | `main()` | 提供 `ocr.Recognize`（[服务接口](09-service-interfaces.md) 第 11 节）；图像的宽高与数据长度不符时回 `invalid_argument` |
| `engine.py` | `class RapidOcrEngine`：`recognize(rgb, languages) -> list[TextBlock]` | 调用 RapidOCR，把结果转换为统一的文字块，点序按数据模型 1.2 |

## 13 services/viewer

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `main.ts` | 服务入口 | 本机端点提供 `viewer.Publish`、`viewer.SetSharing`、`viewer.SetAccessToken`；浏览器连接提供 `viewer.ListSources`、`viewer.Subscribe`；跟随 `agent.WatchSharing` |
| `sources.ts` | `class SourceRegistry`：`add(start)`、`remove(src)`、`clear()`、`list()`、`watch(cb)`、`frame(id)`；`class Source`：`putFrame`、`setSnapshot`、`event`、`subscribe`、`close` | [后台平台服务](10-backend.md) 5.1 至 5.3 的来源与快照；每路来源保留最近 3 张批次画面 |
| `frames.ts` | `class FrameStore`：`get(id, width, dataSaver, format)`、`drop(ids)` | 按观看端宽度缩放（按 64 像素取整，只缩小不放大）并编码，同一画面、宽度、质量只编码一次 |
| `http.ts` | `startHttp(opts)` | 观看页、`GET /frame/{image_id}`、`/ws` 上的浏览器 WebSocket；`GET /lockout` 只告诉请求方自己还要等几秒（锁定时 WebSocket 被拒，浏览器读不到原因） |
| `web.ts` | `buildWeb()` | 服务启动时用 esbuild 在内存中打包观看页，发行版可以预先打包到 `web/dist` |
| `web/` | 观看页 | 来源列表、画面与译文、段落面板、显示设置、列表布局；用 `@sth/render` 绘制。重新连上或来源恢复时重新订阅，新快照到来前保留原来的画面；列表布局也遵守"显示译文"（关掉时列出原文），只对画面起作用的设置在列表布局下隐藏 |

第一版的做法：

- **浏览器连接**：浏览器在 `/ws` 上讲同一套服务协议，握手的 `kind` 为 `browser`，出示访问码而不是本机会话令牌；升级请求必须带同源的 `Origin`，否则在握手前拒绝，防止别的网站借用户的浏览器连进来。同一地址连续 10 次访问码错误后锁定一分钟。浏览器只能调用 `ListSources` 和 `Subscribe`，`Publish` 等方法只在本机端点上提供；
- **批次画面走 HTTP**：`GetFrame` 改为 `GET /frame/{image_id}?w=&saver=&accept=`，访问码放在 `Authorization: Bearer` 头里。浏览器解码图片用原生的 `fetch` 加 `createImageBitmap` 最直接，也省去把几百 KB 的图片拆进协议消息。语义与 [服务接口](09-service-interfaces.md) 第 19 节相同：宽度为 $\min(w, W)$，同一编码共用；
- **质量的默认值**（[待定事项](../requirements/open-questions.md) 第 2 节）：WebP 质量 72，JPEG 78；省流模式宽度乘 0.6，WebP 45，JPEG 50；
- **落后的订阅者**：`Stream.writable` 为假（额度用完）时记下落后、丢弃之后的事件，额度恢复后先发一份新快照（09 第 19 节）。观看页解码完一张画面才取下一条消息，所以手机慢时服务自然停下；
- **访问码**：12 个字符，取自去掉了易混字符的 31 个字母和数字，约 60 位；放在链接的 `#k=` 后面，浏览器不会把它发给服务器，页面读到后存进本地存储并从地址栏去掉；
- **列表布局**：整块桌面缩到手机宽度后字太小，观看页可以改成按阅读顺序列出译文（用归一化的 XY 切分对段落框排序），点一项展开原文。这是需求 01 第 5.4 节之外的补充，默认仍是画面加译文。

## 14 services/assistant

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `main.ts` | 服务入口 | 提供 `assistant.Session`、`assistant.Tools`，以及给 MCP 代理的 `ListSessionTools`、`CallTool` |
| `session.ts` | `class AssistantSession`：`start()`、`wake(ev)`、`userMessage(text)`、`pause()`、`resume()`、`setTask(t)`、`stop()` | [AI 助手](17-assistant.md) 第 2 节；一次只运行一轮，待处理位只留最新的一次，用户消息不会被心跳叫醒替换 |
| `heartbeat.ts` | `class Heartbeat`：`sample()`、`markWake(frame)`；`tileChanges(a, b)` | 17 第 3 节 |
| `win.ts` | `foregroundWindow()`、`userIdleMs()` | 前台程序和空闲时长（koffi） |
| `gate.ts` | `class RuleGate`、`class JevGate`、`class CompositeGate`；`hardLimits()`、`jevAsk()`、`makeGate()` | 17 第 4 节、第 10.2 节 |
| `platform.ts` | `class Platform`：`grab(region?)`、`read(img)`、`translations()`、`annotate(items)`、`clearAnnotations(ids?)`、`close()` | 经主程序取得采集、OCR、归一化、协调器和覆盖层 |
| `tools.ts` | `platformTools(ctx): PlatformTool[]`；`systemPrompt(task)` | 17 第 6 节，TypeBox 定义一份，供 pi 和 MCP 共用 |
| `brain-pi.ts` | `class PiBrain` | 17 第 5.2 节、第 10.3 节 |
| `brain-claude.ts` | `class ClaudeCodeBrain`；`wakeText(ev)`；`withTask(text, task)`：会话中途设定的任务放在下一次叫醒的消息前；`removeStaleDirs()` | 17 第 5.2 节、第 10.3 节 |
| `mcp.ts` | 独立进程 | Claude Code 启动的 MCP stdio 代理 |

桌面端的 AI 卡片在 `apps/desktop/src/main/assistant-card.ts`（`class AssistantCard`：`summon()`、`ask(text)`、`close()`）和 `renderer/assistant.*`。

## 15 apps/desktop

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
主程序核心在 `packages/agent-core`：

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `agent.ts` | `class AgentCore`：`start()`、`provide(svc, iface, methods)`、`alias(name, target)`、`waitFor(name)`、`setSharing(on)`；`agent` 接口的 `Register`、`ListServices`、`Acquire`、`WatchSharing`、`Notify`、`SaveHistory` | 服务清单与转发（[服务接口](09-service-interfaces.md) 第 3 节） |
| `supervisor.ts` | `class Supervisor`：`define(spec)`、`ensure(name)`、`stop(name)`、`stopAll()` | 按需启动（经标准输入传启动信息）、退避重启、连续崩溃 5 次后放弃；没能启动的进程（命令或工作目录不存在，只有 `error` 没有 `exit`）同样按退出处理，问题修好后可以再次启动；每个服务一个日志文件 |
| `catalog.ts` | `catalog(opts): ServiceSpec[]` | 第一版的服务清单 |
| `runs.ts` | `class RunLauncher`：`start(doc, trigger): RunHandle`、`details(runId)` | 按工作流发起运行，跟踪状态，转发暂停、继续、停止和人工重试 |
| `recording.ts` | `class RecordingDisplays` | 无界面运行时代替覆盖层和浮卡，记录收到的显示事件 |

Electron 部分在 `apps/desktop/src`：

| 文件 | 函数与类型 | 职责 |
| --- | --- | --- |
| `main/main.ts` | 应用入口 | 单实例、托盘、设置、服务定义、入口（截图、持续翻译、显隐、交互模式）、全局快捷键、开发控制端口 |
| `main/settings.ts` | `class SettingsStore`：`update(patch)`；`workflows(settings)` | 设置文件位于 `%APPDATA%\screen-translate-hub`，补丁按嵌套对象合并；从设置生成两个入口的工作流（翻译源顺序即名次） |
| `main/layered.ts` | `class LayeredSurface`：`update(bgra, w, h)`、`setBounds(b)`、`show()`、`hide()`、`setClickThrough(on)`、`destroy()` | 原生分层窗口，见第 15.1 节 |
| `main/host.ts` | `class OverlayHost`：`send(msg)`、`setBounds(b)`、`show()`、`hide()`、`eval(js)`、`frame()`、`close()` | 离屏渲染的页面加一个分层窗口；覆盖层、原位截图结果、AI 标注共用 |
| `main/overlay.ts` | `class OverlayManager`：`overlay.Attach`、`overlay.Annotate`、`toggleVisible()`、`toggleInteractive()`、`applySettings(s)` | 覆盖层：每 60 ms 跟随采集范围或被采集的窗口，窗口最小化时隐藏；交互模式下轮询指针，悬停显示原文，单击复制 |
| `main/select.ts` | `selectRegion(env, grab): Promise<Selection \| null>`；`cropImage(img, rect)` | 框选：先截整屏，在不透明全屏窗口中显示冻结的画面，结果从这张截图裁出 |
| `main/card.ts` | `class CardService`：`card.Open`、`dismissInPlace()` | 截图结果：画在原位（Esc 或在结果之外点击关闭，两者都轮询按键状态，不注册全局热键）或截图浮卡（截图保持宽高比） |
| `main/win32.ts` | `windowFrame(hwnd)`、`isWindow`、`isMinimized`、`foregroundWindow()`、`topWindowAt(x, y)`、`placeAbove(hwnd, target)`、`cursorPos()`、`leftButtonDown()`、`windowInfo(hwnd)` | koffi 调用 user32、dwmapi |
| `renderer/*` | 各窗口的页面 | 覆盖层、原位结果、浮卡、AI 标注、框选、设置 |

### 15.1 覆盖层的绘制与层级

Chromium 的透明窗口依赖 GPU 合成。远程桌面、虚拟显示器和部分驱动下只有软件合成，透明窗口完全不显示，开发机就是这种情况（[开发记录](../dev-log.md)）。第一版的覆盖层因此不用透明的 `BrowserWindow`：

1. 页面在离屏的 `BrowserWindow` 中渲染（`webPreferences.offscreen`，每秒最多 30 帧），每次 `paint` 事件给出整页的预乘 BGRA 位图；
2. 位图复制进一个 DIB，用 `UpdateLayeredWindow`（`ULW_ALPHA`）推给一个原生弹出窗口，扩展样式为 `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，不需要 GPU；
3. `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 排除采集；交互模式去掉 `WS_EX_TRANSPARENT`；
4. 离屏页面创建时尺寸被限制在工作区内，加载后重新设置内容尺寸；覆盖整块显示器的窗口少一像素高，否则系统把它当作全屏程序，把任务栏压到其他窗口下面。

跟随窗口时覆盖层不置顶，每次跟随检查都把它放到目标窗口正上方（`placeAbove`）。后台进程调用 `SetWindowPos(HWND_TOP)` 返回成功却不生效，能做的只有"插到某个窗口之后"和"自己的窗口置顶、取消置顶"；插到置顶窗口之后又会让窗口变成置顶，盖住无关的对话框。所以：目标窗口上方是置顶窗口（目标在普通层最上）时，先置顶再 `HWND_NOTOPMOST`，落在普通层最上；否则插在目标上方那个窗口之后。

### 15.2 历史记录、工作流文件和代理

- **历史记录**（需求 09 第 2 节"部分"）：`packages/agent-core/src/history.ts` 的 `HistoryStore` 在 `%APPDATA%\screen-translate-hub\history\YYYY-MM-DD\` 下每条记录写一个 JSON 文件（目录和文件名用本地时间，记录内的时间是 UTC）；截图翻译另存一张 JPEG（由主程序用 `nativeImage` 编码，`agent-core` 不依赖 Electron）。截图翻译完成时运行协调器经 `agent.SaveHistory` 发送原文、译文、失败原因和相对位置；AI 助手会话结束时发送任务和对话。不做容量管理和同步，托盘菜单可以打开这个目录；
- **原位截图结果的关闭**：Esc，或者在结果范围之外按下鼠标左键。结果窗口让点击穿透，所以按键是轮询得到的（每 50 毫秒），在结果范围之内的点击照常交给下面的窗口；
- **工作流文件**：节点编辑器之前，数据目录下的 `workflows/screenshot.json`、`workflows/continuous.json` 存在时代替从设置生成的默认工作流。文件先经 `@sth/workflow` 的静态校验，`entry` 也必须对应；有问题时弹出通知并沿用默认工作流；
- **外部服务的代理**：翻译源和 AI 助手的设置可以带 `proxy`（如 `http://127.0.0.1:7890`）。服务进程启动时带上 `NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY=127.0.0.1,localhost`，Node 24 的 `fetch` 据此经代理连接外部服务，本机服务之间的连接不受影响。Claude Code 子进程继承同样的变量。

## 16 开发与测试

- 单元测试：`npm test` 运行全部 TS 包的 `node:test`，`npm run test:py` 运行 Python 包；
- 端到端（无界面）：`tools/dev/e2e.ts` 启动无界面主程序，用回放采集和模拟翻译源跑通单次截图和持续屏幕，比较记录显示端收到的事件（[验收与测试](16-acceptance.md) 第 2、4 节）；
- 桌面实测：经 SSH 开发时，`tools/win/desktop.ps1 restart` 构建并经计划任务在桌面会话中启动主程序（`run-in-desktop.ps1`），带 `--dev-control` 打开本机控制端口；`-Capturable` 加 `--debug-capturable`，平台窗口不排除在采集之外，用于看真实层级；
- 开发控制：`tools/dev/ctl.ts` 发起截图翻译、开始和停止持续翻译、改设置、取运行详情，`desktop-shot` 经采集服务截整屏，`overlay-shots` 取各浮层页面最后渲染的一帧，`overlay-eval` 在浮层页面里执行脚本，`win-info` 给出浮层、前台窗口和指针下的窗口；`compose.ts` 把浮层帧合成到桌面截图上；
- 版式问题：`ocr-dump.py` 对截图做 OCR，`norm-dump.ts` 打印归一化得到的段落；
- 可控的测试窗口：`tools/dev/stage.py` 显示一篇英文文章，经控制文件滚动、改写段落、移动窗口；`tools/win/set-cursor.py` 移动指针，`zorder.py` 打印窗口层级；`details-summary.ts` 按批次汇总运行详情。
