# 服务接口

对应需求：[服务拆分](../requirements/06-services.md) 第 2、5 节，[账号、设备与共享](../requirements/05-accounts-devices-sharing.md) 第 3、4 节，[工作流](../requirements/02-workflow.md) 第 3 节。

本文定义每类服务的接口：方法、调用形态、消息和行为规则。协议层的帧、流、时限和状态码见 [服务协议](08-service-protocol.md)；消息中的数据结构与 [数据模型](02-data-model.md) 一一对应，第 2 节给出它们的 Protocol Buffers 编码。

## 1 接口总表

| 接口 | 版本 | 实现者 | 调用者 |
| --- | --- | --- | --- |
| `agent` | 1.0 | 桌面端主程序 | 本机服务、运行协调器 |
| `capture` | 1.0 | 屏幕采集服务，含变化检测（系统集成） | 运行协调器 |
| `region_select` | 1.0 | 框选截图服务（系统集成） | 运行协调器 |
| `selection` | 1.0 | 取词服务（系统集成） | 运行协调器 |
| `overlay` | 1.0 | 本机覆盖层服务（系统集成） | 运行协调器 |
| `card` | 1.0 | 浮卡与对话面板服务（系统集成） | 运行协调器 |
| `hint` | 1.0 | 鼠标旁提示服务（系统集成） | 运行协调器 |
| `hotkey` | 1.0 | 快捷键与输入事件服务（系统集成） | 主程序 |
| `window_tracker` | 1.0 | 窗口跟踪服务（系统集成） | 覆盖层、屏幕采集 |
| `ocr` | 1.0 | OCR 服务 | 运行协调器 |
| `normalize` | 1.0 | 归一化服务 | 运行协调器 |
| `translate` | 1.0 | 翻译服务，以及提供翻译能力的 AI 适配服务 | 运行协调器 |
| `llm` | 1.0 | AI 适配服务 | 运行协调器、浏览器 |
| `vision` | 1.0 | AI 适配服务 | 运行协调器 |
| `http_request` | 1.0 | 自定义 HTTP 请求服务 | 运行协调器 |
| `coordinator` | 1.0 | 运行协调器 | 主程序 |
| `registry` | 1.0 | 服务注册 | 各服务、主程序、运行协调器、浏览器 |
| `auth` | 1.0 | 账号与认证 | 浏览器、设备连接与中转、服务注册、观看分发 |
| `viewer` | 1.0 | 观看分发 | 运行协调器、主程序、浏览器 |
| `config` | 1.0 | 工作流与配置存储 | 浏览器、主程序、服务注册，以及读取自身设置的后台服务 |
| `history` | 1.0 | 历史记录存储 | 主程序、浏览器 |

`hotkey` 和 `window_tracker` 只在桌面端内部使用，不开放给其他设备。

## 2 公共数据结构

以下定义是 [数据模型](02-data-model.md) 的线路编码。字段的含义以数据模型为准，这里只给出类型和编号。

```proto
syntax = "proto3";
package sth.model.v1;

message Rect   { int32 x = 1; int32 y = 2; int32 w = 3; int32 h = 4; }
message RectF  { double x = 1; double y = 2; double w = 3; double h = 4; }
message Point  { double x = 1; double y = 2; }
message Quad   { repeated Point points = 1; }          // 恰好 4 个点，点序见数据模型 1.2
message QuadRel  { repeated float xy = 1; }             // 相对坐标，x1 y1 x2 y2 x3 y3 x4 y4
message RectRel  { float x = 1; float y = 2; float w = 3; float h = 4; }

message CaptureGeometry {
  enum Kind { KIND_UNSPECIFIED = 0; DISPLAY = 1; WINDOW = 2; REGION = 3; }
  Kind kind = 1;
  string display_id = 2;
  optional uint64 window_id = 3;
  double origin_x = 4;
  double origin_y = 5;
  double scale = 6;
  uint32 width = 7;
  uint32 height = 8;
}

message EncodedImage {
  enum Format {
    FORMAT_UNSPECIFIED = 0; RAW_BGRA8 = 1; PNG = 2; WEBP_LOSSLESS = 3; WEBP = 4; JPEG = 5;
  }
  Format format = 1;
  uint32 width = 2;
  uint32 height = 3;
  bytes data = 4;
}

message Image {
  EncodedImage image = 1;
  CaptureGeometry geometry = 2;
  string captured_at = 3;                               // RFC 3339 UTC
}

enum Direction { DIRECTION_UNSPECIFIED = 0; LTR = 1; RTL = 2; TTB = 3; }

message TextBlock {
  uint32 block_id = 1;
  string text = 2;                                      // 逻辑顺序
  Quad quad = 3;
  Direction direction = 4;                              // 未提供时为 DIRECTION_UNSPECIFIED
  optional float confidence = 5;
  optional string language = 6;
  repeated Quad char_quads = 7;
}

message OcrRegion {
  Rect rect = 1;
  double scale = 2;
  repeated TextBlock blocks = 3;
  string engine = 4;
}

message OcrResult {
  string run_id = 1;
  uint64 batch_seq = 2;
  repeated OcrRegion regions = 3;
}

message ReuseRef { uint64 batch_seq = 1; uint32 paragraph_id = 2; int32 dx = 3; int32 dy = 4; }

message Unit {
  uint32 paragraph_id = 1;
  uint32 order = 2;
  string text = 3;
  optional string language = 4;
  Direction direction = 5;
  repeated TextBlock lines = 6;
  optional RectF bounds = 7;
  enum Origin { ORIGIN_UNSPECIFIED = 0; RECOGNIZED = 1; REUSED = 2; INJECTED = 3; }
  Origin origin = 8;
  optional ReuseRef reused_from = 9;
  optional string context_text = 10;
}

message Shift { int32 dx = 1; int32 dy = 2; }

message ChangeMap {
  uint64 base_frame_id = 1;                             // 上一个批次的画面
  uint64 frame_id = 2;
  uint32 tile = 3;
  uint32 cols = 4;
  uint32 rows = 5;
  repeated Shift shifts = 6;                            // 第 0 项为 (0, 0)，最多 8 项
  bytes masks = 7;                                      // cols × rows 字节，按行存放
  float changed_ratio = 8;
}

message GlossaryItem { string source = 1; string target = 2; optional string note = 3; }

enum EndState {
  END_STATE_UNSPECIFIED = 0; COMPLETE = 1; PARTIAL = 2; PROVISIONAL = 3; ERROR = 4; ABORTED = 5;
}
enum Via { VIA_UNSPECIFIED = 0; RACE = 1; REUSE = 2; CACHE = 3; }

message DisplayEvent {
  string stream_id = 1;
  uint64 seq = 2;
  string run_id = 3;
  oneof event {
    RunState run_state = 10;
    BatchStart batch_start = 11;
    ParagraphAdd paragraph_add = 12;
    ParagraphShow paragraph_show = 13;
    ParagraphEnd paragraph_end = 14;
    Notice notice = 15;
    BatchEnd batch_end = 16;
    HeldRelease held_release = 17;
  }
}

message RunState {
  enum State { STATE_UNSPECIFIED = 0; RUNNING = 1; PAUSED = 2; STOPPED = 3; }
  State state = 1;
  optional string reason = 2;
}

message Carry { uint32 paragraph_id = 1; uint32 from_paragraph_id = 2; float dx = 3; float dy = 4; }
message FrameRef { string image_id = 1; uint32 width = 2; uint32 height = 3; }

message BatchStart {
  uint64 batch_seq = 1;
  optional FrameRef frame = 2;                          // 只发给网页显示
  optional CaptureGeometry geometry = 3;                // 只发给本机覆盖层
  repeated Carry carried = 4;
  repeated uint32 held = 5;                             // 上一批次中保留显示的段落
}

message ParagraphAdd {
  uint32 paragraph_id = 1;
  string text = 2;
  optional string language = 3;
  Direction direction = 4;
  repeated QuadRel quads = 5;
  RectRel bounds = 6;
  optional uint32 takes_over = 7;                       // 接替的保留段落
}

message HeldRelease { repeated uint32 paragraph_ids = 1; }

message ParagraphShow {
  uint32 paragraph_id = 1;
  enum Kind { KIND_UNSPECIFIED = 0; TEXT = 1; ERROR_MARK = 2; }
  Kind kind = 2;
  optional string text = 3;
  optional uint32 source_rank = 4;
  optional uint32 version = 5;
  optional bool final = 6;
  optional string error_reason = 7;
}

message ParagraphEnd { uint32 paragraph_id = 1; EndState end_state = 2; Via via = 3; }

message Notice {
  string notice_id = 1;
  enum Kind { KIND_UNSPECIFIED = 0; PREFERRED_UNAVAILABLE = 1; }
  Kind kind = 2;
  string race_node = 3;
  string reason = 4;
  bool active = 5;
}

message BatchEnd {
  uint64 batch_seq = 1;
  enum EndedBy { ENDED_BY_UNSPECIFIED = 0; SETTLED = 1; DEADLINE = 2; PAUSE = 3; STOP = 4; }
  EndedBy ended_by = 2;
}

message ParagraphView {
  ParagraphAdd paragraph = 1;
  optional ParagraphShow shown = 2;
  optional EndState end_state = 3;
  optional Via via = 4;
}

message DisplaySnapshot {
  string stream_id = 1;
  uint64 seq = 2;
  RunState run_state = 3;
  uint64 batch_seq = 4;
  optional FrameRef frame = 5;
  optional CaptureGeometry geometry = 6;
  repeated ParagraphView paragraphs = 7;
  repeated Notice notices = 8;
  repeated ParagraphView held = 9;                      // 标识是上一批次的段落标识
}

message ReplyUpdate {                                   // AI 回答的累计文字
  uint32 turn = 1;                                      // 第几轮问答，从 1 开始
  string text = 2;
  bool final = 3;
}
```

`ParagraphShow` 的显示种类在数据模型中写作 `text` 和 `error`；这里的 `ERROR_MARK` 避开与 `EndState.ERROR` 同名。

## 3 主程序：`agent`

主程序是桌面端的服务清单和转发点（[架构](01-architecture.md) 2.1）。

| 方法 | 形态 | 请求 | 回复 | 用途 |
| --- | --- | --- | --- | --- |
| `Register` | 双方连续收发 | 服务描述和本机端点 | 登记结果；之后这项服务的设置每变化一次，下发一次 | 本机服务登记；流关闭即注销 |
| `ListServices` | 一问一答 | 可选的接口名 | 本机服务列表 | 运行前检查解析 `local` 绑定，节点编辑器列出本机服务 |
| `Acquire` | 服务端连续回复 | 服务的登记名称 | 服务就绪时回复描述和本机端点；服务重新登记时再回复一次 | 运行协调器在一次运行期间占用一项本机服务 |
| `WatchSharing` | 服务端连续回复 | 无 | 屏幕共享开关的当前状态和每次变化 | 运行协调器决定是否向观看分发发送画面 |
| `SaveHistory` | 一问一答 | 历史记录条目 | 条目标识 | 自动保存和"保存到历史记录"节点 |
| `Notify` | 一问一答 | 通知的种类和文字 | 无 | 运行协调器请求主程序发出系统通知 |

规则：

- `ListServices` 返回的每一项包含服务描述、本机端点路径、是否已开放，以及生效的上限：服务描述中的默认值，被用户调低的值覆盖。保留名称 `bundled.ocr`、`bundled.translate` 在这里解析为这台电脑自带的引擎（[工作流定义](03-workflow.md) 4.2）。桌面端独立使用时没有服务注册，本机的运行协调器按这里的生效上限排队；
- 运行协调器为一次运行用到的每项本机服务打开一条 `Acquire` 流，从回复中取得端点后直接连接（[服务协议](08-service-protocol.md) 8.3）。服务还没有运行时，主程序先启动它，等它登记后再回复。流打开期间，主程序不按空闲回收这项服务（[桌面端](12-desktop.md) 1.2）。服务崩溃后被主程序重新启动、重新登记时，主程序在同一条流上推送新的描述和端点，运行协调器按服务协议第 11 节检查版本，兼容时恢复可用（[运行协调器](04-run-coordinator.md) 6.3）。运行结束时，运行协调器关闭这些流；
- 主程序在登记流上向服务下发它的设置：用户调低的并发上限和速率上限、费用上限、单独指定的出站代理（需求 04 第 10 节，需求 01 第 2.5 节）。登记被接受后发一次，用户修改设置后再发一次。服务按收到的设置执行限速、计量和代理；
- 运行协调器只在屏幕共享开着、并且工作流包含网页显示节点时，才向观看分发发送画面和显示事件（需求 05 第 4.3 节）。共享关闭后，它立即停止发送；观看分发同时丢弃这一路来源的快照；
- 本机端点路径的长度不超过 100 字节。macOS 的 Unix 域套接字路径上限是 104 字节，超过时无法绑定。

```proto
package sth.agent.v1;

message RegisterRequest { sth.registry.v1.ServiceManifest manifest = 1; string endpoint = 2; }
message RegisterReply {
  oneof msg {
    RegisterResult result = 1;                          // 第一条
    sth.config.v1.ServiceSettings settings = 2;         // 登记被接受后发一次，设置变化时再发
  }
}
message RegisterResult { bool accepted = 1; string reason = 2; }

message ListServicesRequest { optional string interface = 1; }
message LocalService {
  sth.registry.v1.ServiceManifest manifest = 1;
  string endpoint = 2;              // 命名管道名或 Unix 域套接字路径
  bool exposed = 3;
  repeated string aliases = 4;      // 例如 bundled.ocr
  sth.registry.v1.Limits effective_limits = 5;          // 默认值被用户调低的值覆盖之后
}
message ListServicesReply { repeated LocalService services = 1; }

message AcquireRequest { string service = 1; }          // 登记名称
message AcquireReply { sth.registry.v1.ServiceManifest manifest = 1; string endpoint = 2; }

message SharingState { bool enabled = 1; }

message NotifyRequest {
  enum Kind { KIND_UNSPECIFIED = 0; PREFERRED_RECOVERED = 1; RUN_INTERRUPTED = 2; }
  Kind kind = 1;
  string run_id = 2;
  string text = 3;
}
```

## 4 屏幕采集：`capture`

屏幕采集服务负责截屏和变化检测（需求 06 第 3.1 节），会话内的规则见 [变化检测](05-change-detection.md)。

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Session` | 双方连续收发 | 持续屏幕的采集会话，流的生命周期就是会话的生命周期 |
| `Grab` | 一问一答 | 截取一张当前画面：整块显示器、某个窗口、某个区域或鼠标附近的区域，供图片输入节点使用 |

`Session` 中，运行协调器发送：

| 消息 | 内容 |
| --- | --- |
| `Start` | 采集范围、触发方式、容差 $\tau$、方块边长 $t$、画面编码方式。必须是第一条消息 |
| `TakeBatch` | 最长等待时长，见 [运行协调器](04-run-coordinator.md) 3.1 |
| `Pause`、`Resume` | 暂停和恢复采集，见 [变化检测](05-change-detection.md) 第 1 节 |

屏幕采集服务发送：

| 消息 | 内容 |
| --- | --- |
| `Started` | 采集已开始，附带采集几何 |
| `Batch` | 画面编号 `frame_id`、批次画面、相对上一批次画面的变化图；会话的第一个批次没有变化图。批次序号由运行协调器编号（[运行协调器](04-run-coordinator.md) 3.1） |
| `NoBatch` | 等待时长内没有被接受的画面 |
| `Paused`、`Resumed` | 确认暂停和恢复 |
| `Interrupted` | 采集在平台之外被中止，附带原因 |

画面编码方式由运行协调器在 `Start` 中指定：运行协调器在同一台电脑上时用 `RAW_BGRA8`，不必编码；在后台时用无损的 `WEBP_LOSSLESS` 或 `PNG`，OCR 的输入不因压缩失真。

`Interrupted` 的原因：

| 原因 | 情形 |
| --- | --- |
| `USER_STOPPED` | 用户在 macOS 菜单栏的屏幕共享指示中结束了采集（需求 07 第 5.2 节） |
| `TARGET_CLOSED` | 采集范围是固定的窗口，这个窗口被关闭。跟随活动窗口时不报告，屏幕采集服务改为采集下一个前台窗口 |
| `DISPLAY_REMOVED` | 采集的显示器被移除 |
| `SYSTEM_STOPPED` | 系统停止了采集 |
| `PERMISSION_REVOKED` | 屏幕录制权限被撤销 |

运行协调器对 `TARGET_CLOSED` 和 `DISPLAY_REMOVED` 停止运行：采集范围已经不存在，运行中又不能更换范围（需求 04 第 8.3 节）。对其余原因按暂停处理。

```proto
package sth.capture.v1;

message CaptureRange {
  oneof range {
    string display_id = 1;
    uint64 window_id = 2;
    Region region = 3;
    bool follow_active_window = 4;
  }
}
message Region { string display_id = 1; double x = 2; double y = 3; double w = 4; double h = 5; } // 桌面坐标

message Trigger { uint32 interval_ms = 1; }    // 事件触发在后续版本加入

message SessionClientMessage {
  oneof msg {
    Start start = 1;
    TakeBatch take_batch = 2;
    Pause pause = 3;
    Resume resume = 4;
  }
}
message Start {
  CaptureRange range = 1;
  Trigger trigger = 2;
  uint32 tolerance = 3;
  uint32 tile = 4;
  sth.model.v1.EncodedImage.Format frame_format = 5;
}
message TakeBatch { uint32 wait_ms = 1; }
message Pause {}
message Resume {}

message SessionServerMessage {
  oneof msg {
    Started started = 1;
    Batch batch = 2;
    NoBatch no_batch = 3;
    Paused paused = 4;
    Resumed resumed = 5;
    Interrupted interrupted = 6;
  }
}
message Started { sth.model.v1.CaptureGeometry geometry = 1; }
message Batch {
  uint64 frame_id = 1;                                  // 批次序号由运行协调器编号
  sth.model.v1.Image frame = 2;
  optional sth.model.v1.ChangeMap change_map = 3;
}
message NoBatch {}
message Paused {}
message Resumed {}
message Interrupted {
  enum Reason {
    REASON_UNSPECIFIED = 0; USER_STOPPED = 1; TARGET_CLOSED = 2;
    DISPLAY_REMOVED = 3; SYSTEM_STOPPED = 4; PERMISSION_REVOKED = 5;
  }
  Reason reason = 1;
}

message GrabRequest {
  oneof target {
    string display_id = 1;
    uint64 window_id = 2;
    Region region = 3;
    MouseRegion mouse_region = 4;
  }
  sth.model.v1.EncodedImage.Format format = 5;
}
message MouseRegion { double width = 1; double height = 2; }   // 桌面坐标单位，以鼠标位置为中心
```

`Grab` 的回复是 `sth.model.v1.Image`。

## 5 框选截图：`region_select`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Select` | 一问一答 | 画面编码方式 | 截图，或者用户放弃了框选 |

服务在所有显示器上显示框选界面，用户框选后返回截图。用户按 Esc 放弃时，回复中写明用户放弃，流以 `ok` 结束；运行随之进入 `completed`，不显示任何提示。`cancelled` 只表示调用方取消（[服务协议](08-service-protocol.md) 第 7 节），所以用户放弃用回复内容表示。

```proto
package sth.region_select.v1;

message SelectReply {
  oneof result {
    sth.model.v1.Image image = 1;
    bool user_cancelled = 2;
  }
}
```

框选界面本身也属于平台自己绘制的窗口，必须排除在采集之外（需求 01 第 5.6 节）；返回的截图取自用户开始框选那一刻的画面，不包含框选界面。

## 6 取词：`selection`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Get` | 一问一答 | 无 | 选中的文字，或者取不到的原因 |

取不到文字不算调用失败：回复中写明原因，由划词浮卡向用户说明（需求 01 第 4.3 节）。

| 原因 | 说明 |
| --- | --- |
| `NO_SELECTION` | 当前没有选中的文字 |
| `ELEVATED_TARGET` | 前台程序以管理员身份运行，Windows 的特权隔离阻止读取（需求 07 第 4.1 节） |
| `UNSUPPORTED_APP` | 程序不提供可读取的文字，例如游戏和图片中的文字 |
| `PERMISSION_MISSING` | macOS 没有授予辅助功能权限（需求 07 第 4.2 节） |
| `SECURE_INPUT` | 有程序开启了安全输入，例如正在输入密码 |
| `TIMEOUT` | 目标程序没有在时限内响应 |

```proto
package sth.selection.v1;

message GetReply {
  oneof result {
    string text = 1;
    Failure failure = 2;
  }
  enum Method { METHOD_UNSPECIFIED = 0; ACCESSIBILITY = 1; CLIPBOARD = 2; }
  Method method = 3;                 // 取到文字时，说明用的是哪种方式
}
message Failure {
  enum Reason {
    REASON_UNSPECIFIED = 0; NO_SELECTION = 1; ELEVATED_TARGET = 2; UNSUPPORTED_APP = 3;
    PERMISSION_MISSING = 4; SECURE_INPUT = 5; TIMEOUT = 6;
  }
  Reason reason = 1;
}
```

## 7 本机覆盖层：`overlay`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Attach` | 客户端连续发送 | 第一条为 `OverlayStart`，第二条为显示快照，之后是显示事件 | 无 |

`OverlayStart` 给出运行标识、显示流标识、采集范围和目标语言；采集范围是窗口时，覆盖层用窗口跟踪服务跟随它（[显示与排版](07-display.md) 2.1）。之后运行协调器先发送这条显示流当前的显示快照，再按顺序发送此后的事件。每次打开 `Attach` 流都是如此，包括后台断连、主程序经 `coordinator.Attach` 接上运行后重新打开的流：断连期间的事件不会补发，覆盖层从快照恢复（[显示与排版](07-display.md) 第 1 节）。

运行停止时，运行协调器发送 `HalfClose`。覆盖层保留停止瞬间的绘制（需求 04 第 6 节），直到用户用"显示或隐藏覆盖层"快捷键隐藏它，或者开始新的持续屏幕运行，然后以 `ok` 结束流。流因为连接中断而结束时，覆盖层同样保留最后的绘制；运行协调器不可用的提示由主程序以系统通知发出，不画在覆盖层上，显示画面上的提示仍只有需求 04 第 7 节规定的两种。

```proto
package sth.overlay.v1;

message AttachMessage {
  oneof msg {
    OverlayStart start = 1;
    sth.model.v1.DisplayEvent event = 2;
    sth.model.v1.DisplaySnapshot snapshot = 3;
  }
}
message OverlayStart {
  string run_id = 1;
  string stream_id = 2;
  sth.capture.v1.CaptureRange range = 3;
  string target_language = 4;                          // 判断译文是否竖排时使用
}
```

## 8 浮卡与对话面板：`card`

截图浮卡、划词浮卡和桌面对话面板由同一个服务提供，区别在于窗口的种类。

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Open` | 双方连续收发 | 一张浮卡或一个对话面板的完整生命周期 |

运行协调器发送：

| 消息 | 内容 |
| --- | --- |
| `CardStart` | 窗口种类（截图浮卡、划词浮卡、对话面板）、要显示的图片、位置提示、要复用的已有窗口、目标语言。必须是第一条消息 |
| `sth.model.v1.DisplaySnapshot` | 截图浮卡译文层的显示快照，紧跟在 `CardStart` 之后（[显示与排版](07-display.md) 第 1 节） |
| `sth.model.v1.DisplayEvent` | 截图浮卡的译文层 |
| `CandidateUpdate` | 划词浮卡的译文：累计文字、版本、完成标记 |
| `sth.model.v1.ReplyUpdate` | AI 的回答 |
| `CardError` | 失败的原因，例如取不到选中的文字、翻译失败、AI 服务不可用 |

浮卡发送：

| 消息 | 内容 |
| --- | --- |
| `Opened` | 窗口已经显示，附带浮卡标识，供以后复用这个窗口 |
| `FollowUp` | 用户的追问：问题文字、新的轮次号，以及用户附加的图片和文本文件 |
| `Closed` | 用户关闭了窗口 |

用户附加的文本文件，运行协调器把文件名和内容作为一个文字部分放进发给 AI 的消息；图片作为图片部分，交给视觉 AI（第 14 节）。附件随对话一起保存到历史记录（需求 01 第 8 节）。

规则：

- 用户关闭窗口时，服务发送 `Closed` 后以 `ok` 结束流，运行协调器随即结束这次运行（[运行协调器](04-run-coordinator.md) 2.1）；
- 划词浮卡只显示译文时，上面的"问 AI"按钮由主程序直接处理：主程序以同一段文字触发划词入口的 `ask_ai` 端口，发起一次新的运行，新运行的 `CardStart` 指定复用这张浮卡（[工作流定义](03-workflow.md) 5.2）。旧运行的流随即以 `ok` 结束；
- 覆盖层交互模式中点击段落弹出的浮卡，也由主程序直接显示原文和完整译文，不经运行协调器；把这一段交给 AI 时，同样发起一次新的划词运行；
- 浮卡不能被激活。用户按"让最近一张浮卡获得键盘焦点"的快捷键时，主程序让最近一张浮卡临时可以被激活并获得键盘焦点，用户在其中输入追问；追问发出、或者用户按 Esc 后，浮卡恢复为不可激活，焦点回到原来的窗口（需求 01 第 5.3 节）。桌面对话面板是普通窗口，用户点击即可输入（[桌面端](12-desktop.md) 3.3、4.4）。

```proto
package sth.card.v1;

message CardClientMessage {
  oneof msg {
    CardStart start = 1;
    sth.model.v1.DisplayEvent display = 2;
    CandidateUpdate candidate = 3;
    sth.model.v1.ReplyUpdate reply = 4;
    CardError error = 5;
    sth.model.v1.DisplaySnapshot snapshot = 6;
  }
}
message CardStart {
  enum Kind { KIND_UNSPECIFIED = 0; SCREENSHOT = 1; SELECTION = 2; DIALOG = 3; }
  Kind kind = 1;
  optional sth.model.v1.Image image = 2;
  optional Anchor anchor = 3;
  optional string reuse_card_id = 4;
  string run_id = 5;
  string target_language = 6;                          // 截图浮卡判断译文是否竖排时使用
}
message Anchor { double x = 1; double y = 2; }          // 桌面坐标
message CandidateUpdate { string text = 1; uint32 version = 2; bool final = 3; }
message CardError { string reason = 1; }

message CardServerMessage {
  oneof msg {
    Opened opened = 1;
    FollowUp follow_up = 2;
    Closed closed = 3;
  }
}
message Opened { string card_id = 1; }
message FollowUp {
  uint32 turn = 1;
  string question = 2;
  repeated sth.model.v1.EncodedImage images = 3;
  repeated TextFile text_files = 4;
}
message TextFile { string name = 1; string content = 2; }
message Closed {}
```

## 9 鼠标旁提示：`hint`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Show` | 客户端连续发送 | 第一条为 `HintStart`（鼠标位置），之后是 `sth.model.v1.ReplyUpdate` | 无 |

提示随回答逐步显示。回答带完成标记后，运行协调器发送 `HalfClose`，运行结束，提示留在屏幕上；用户点击别处或按 Esc 时提示消失，服务以 `ok` 结束流。提示窗口不接收点击，也不能被激活，所以提示显示期间，主程序临时把 Esc 注册为全局快捷键，并监听全局的鼠标按下事件，提示消失后立即注销，实现方式见 [桌面端](12-desktop.md) 3.3、4.4。这段时间里，前台程序收不到 Esc。回答完成之前提示就被关闭的，运行协调器取消尚未完成的 AI 请求，运行随之结束（[运行协调器](04-run-coordinator.md) 2.1）。

```proto
package sth.hint.v1;

message ShowMessage {
  oneof msg {
    HintStart start = 1;
    sth.model.v1.ReplyUpdate reply = 2;
  }
}
message HintStart { string run_id = 1; double x = 2; double y = 3; }   // 鼠标位置，桌面坐标
```

## 10 快捷键与窗口跟踪

这两个服务只在桌面端内部使用。

`hotkey`：

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Subscribe` | 服务端连续回复 | 主程序订阅全局快捷键事件，每个事件指明是哪一项功能（需求 01 第 4.5 节） |

快捷键与功能的对应关系是主程序的设置。注册失败（组合键已被其他程序占用）时，主程序在设置页标出冲突，提示用户换一个组合。

`window_tracker`：

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Follow` | 服务端连续回复 | 跟随一个窗口：外框位置变化、最小化、还原、关闭 |
| `ActiveWindow` | 服务端连续回复 | 活动窗口的变化，供"跟随活动窗口"的采集范围使用 |

`ActiveWindow` 报告的是用户正在使用的其他应用的窗口：前台是平台自己的窗口，例如主窗口或浮卡时，不报告，采集范围保持原来的窗口。当前窗口关闭后，下一个成为前台的窗口照常报告，屏幕采集服务改为采集它（需求 04 第 8.3 节）。

窗口外框的确切定义、遮挡的处理，见 12 桌面端。

## 11 OCR：`ocr`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Recognize` | 一问一答 | 一组区域图片和识别语言 | `sth.model.v1.OcrResult` |

请求中每块区域给出图片、它在批次画面中的位置 `rect` 和缩放比例 `scale`。服务对每块图片分别识别，回复中每块区域的文字块坐标以送入的图片为准，由归一化换算回画面坐标（[归一化](06-normalization.md) 第 2 节）。

服务必须做到：

- 把引擎的输出转换为统一的文字块，引擎给出词级或字级结果时先合并成行（[数据模型](02-data-model.md) 3.1）；
- 文字使用逻辑顺序。引擎按视觉顺序输出从右往左的文字时，服务用 Unicode 双向算法转换（[技术选型](15-tech-selection.md) 6.2）；
- 识别语言不受支持时，以 `invalid_argument` 结束，说明是哪种语言。

```proto
package sth.ocr.v1;

message RecognizeRequest {
  repeated RegionImage regions = 1;
  repeated string languages = 2;          // BCP 47，可以为 auto
  map<string, string> options = 3;        // 引擎自己的选项，名称由服务描述声明
  string run_id = 4;
  uint64 batch_seq = 5;
}
message RegionImage {
  sth.model.v1.EncodedImage image = 1;
  sth.model.v1.Rect rect = 2;
  double scale = 3;
}
```

## 12 归一化：`normalize`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Normalize` | 一问一答 | OCR 结果、复用的段落、新段落的起始编号、画面尺寸 | 本批次的全部翻译单元 |

算法见 [归一化](06-normalization.md)。服务不保存状态，同样的输入总是得到同样的输出。

```proto
package sth.normalize.v1;

message NormalizeRequest {
  sth.model.v1.OcrResult ocr = 1;
  repeated sth.model.v1.Unit reused = 2;
  uint32 first_id = 3;
  uint32 frame_width = 4;
  uint32 frame_height = 5;
}
message NormalizeReply { repeated sth.model.v1.Unit units = 1; }
```

## 13 翻译：`translate`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Translate` | 服务端连续回复 | 一组段落、语言对、术语表、上下文、输出方式 | 每个段落的累计译文，以及单段失败 |

请求可以包含多个段落（需求 03 第 4.3 节），回复按段落分别给出：

- `Update`：某个段落到目前为止的累计译文。`final` 为真表示这个段落已经译完。结束信号单独到达、没有新文字时，`Update` 不带 `text` 字段，运行协调器沿用上一版本的文字（[数据模型](02-data-model.md) 第 5 节）；带有 `text` 字段时，即使是空字符串，也表示累计译文就是它；
- `ParagraphFailed`：某个段落单独失败，附带状态码。其他段落继续翻译，这一段按单段失败处理。

规则：

- 同一个段落的 `Update` 按产生顺序发送；带完成标记的 `Update` 之后，这个段落不再有任何消息；
- 全部段落都已完成或失败后，服务以 `ok` 结束流；
- 输出方式为 `COMPLETE` 时，每个段落只发一条 `Update`，`final` 为真；
- 版本号由运行协调器按收到的顺序编号，服务不需要填写；
- 术语表和提示词模板的用法由服务决定：AI 适配服务把它们写进提示词，翻译引擎按自己支持的方式使用（需求 03 第 4.4 节）；
- 整体性的失败，例如被限流，以流的状态码表示（[服务协议](08-service-protocol.md) 第 7 节）。

```proto
package sth.translate.v1;

message TranslateRequest {
  repeated Segment segments = 1;
  string source_language = 2;             // 可以为 auto
  string target_language = 3;
  repeated sth.model.v1.GlossaryItem glossary = 4;
  repeated string context = 5;            // 排在这组段落之前的原文，只作参考
  enum Mode { MODE_UNSPECIFIED = 0; STREAM = 1; COMPLETE = 2; }
  Mode mode = 6;
  optional string prompt_template = 7;
  map<string, string> options = 8;
}
message Segment {
  uint32 paragraph_id = 1;
  string text = 2;
  optional string language = 3;
}

message TranslateReply {
  oneof msg {
    Update update = 1;
    ParagraphFailed failed = 2;
  }
}
message Update { uint32 paragraph_id = 1; optional string text = 2; bool final = 3; }
message ParagraphFailed { uint32 paragraph_id = 1; sth.wire.v1.Status status = 2; }
```

## 14 AI：`llm` 与 `vision`

| 接口 | 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- | --- |
| `llm` | `Chat` | 服务端连续回复 | 系统提示词、多轮对话、生成参数 | `sth.model.v1.ReplyUpdate` 的序列 |
| `vision` | `Ask` | 服务端连续回复 | 系统提示词、至少一张图片的多轮对话、生成参数 | `sth.model.v1.ReplyUpdate` 的序列 |

追问时，运行协调器把此前的全部轮次放进 `messages` 重新发送，服务不保存对话状态。网页对话面板中就一段译文问 AI 时，浏览器直接经设备连接与中转调用 `llm.Chat`（需求 01 第 6 节）。

计量由服务自己完成。执行计量的服务是 AI 适配服务和自定义 HTTP 请求服务（第 15 节）：每次调用结束后按服务描述中声明的方式累计用量，并立即报告给服务注册，供网页端显示；达到费用上限时，此后的调用以 `quota_exceeded` 结束（需求 04 第 10 节）。服务重启后，先经 `registry.GetUsage` 读回本计费周期已经报告的用量，再继续累计，已经达到上限的服务不会因为重启被重新放行。费用上限的设置见第 20 节。

```proto
package sth.llm.v1;

message ChatRequest {
  string system = 1;
  repeated Message messages = 2;
  Params params = 3;
}
message Message {
  enum Role { ROLE_UNSPECIFIED = 0; USER = 1; ASSISTANT = 2; }
  Role role = 1;
  repeated Part parts = 2;
}
message Part {
  oneof part {
    string text = 1;
    sth.model.v1.EncodedImage image = 2;  // 只用于 vision 接口
  }
}
message Params {
  optional uint32 max_output_tokens = 1;
  optional float temperature = 2;
}
```

`vision.Ask` 使用同样的消息定义，并要求至少有一个 `Part` 是图片。

## 15 自定义 HTTP 请求：`http_request`

| 方法 | 形态 | 请求 | 回复 |
| --- | --- | --- | --- |
| `Send` | 一问一答 | 方法、地址、请求头、请求体 | 状态码、响应头、响应体、经过的重定向 |
| `CheckCredentials` | 一问一答 | 凭据名称的列表 | 其中在这台设备上不存在的名称 |

运行协调器按节点的模板填好请求，再交给绑定位置上的服务发出；收到回复后，运行协调器按节点配置的 JSON 指针取出文字，转成译文候选或 AI 回答（[工作流定义](03-workflow.md) 3.2）。服务在发出前，把请求头和请求体中的 `{{credential:名称}}` 替换为这台设备上保存的凭据，并执行 [安全](11-security.md) 第 9 节的限制。`CheckCredentials` 供运行前检查使用（[工作流定义](03-workflow.md) 6.3 第 5 条），只回答名称是否存在，不返回凭据的内容。

节点作为翻译源或 AI 节点时，运行协调器按下表把外部接口的回复归入失败的两类（[运行协调器](04-run-coordinator.md) 6.3）：

| 回复 | 处理 |
| --- | --- |
| 状态码 2xx，按 JSON 指针取到了文字 | 成功 |
| 状态码 429 | 按 `rate_limited` 处理，属于整体不可用；有 `Retry-After` 响应头时，按它换算重试等待时间 |
| 状态码 503，或者连不上外部地址、TLS 握手失败、请求超时之前没有收到响应头 | 按 `unavailable` 处理，属于整体不可用 |
| 其他非 2xx 状态码；响应体不是合法的 JSON；JSON 指针取不到文字 | 按 `engine_error` 处理，属于单段失败 |

429 和 503 是服务商限流或暂时不可用的标准回复，与请求的内容无关，归入整体不可用：首选源被限流时，段落保留其他源的临时译文，并给出整体提示，不会每一段都变成错误提示（需求 03 第 5.4 节）。

自定义 HTTP 请求服务执行计量和费用上限：按目标地址的主机分别累计调用次数，费用上限也按主机设置（第 20 节）。外部翻译接口经这种节点接入（需求 04 第 10 节），翻译服务本身不访问外部网络。某个主机达到上限后，发往它的请求以 `quota_exceeded` 结束，直到用户调高上限或进入下一个计费周期。服务发出请求时，按设置选择出站代理（需求 01 第 2.5 节）。

## 16 运行协调器：`coordinator`

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Run` | 双方连续收发 | 主程序发起并控制一次运行 |
| `Attach` | 双方连续收发 | 断连后重新接上一次暂停中的运行 |
| `GetRunDetails` | 一问一答 | 读取运行详情，供主程序的运行详情页显示 |

`Run` 中，主程序发送：

| 消息 | 内容 |
| --- | --- |
| `RunStart` | 运行标识（主程序按 UUID 第 7 版生成）、工作流文档、入口用法、发起运行的设备、触发信息。必须是第一条消息 |
| `Control` | 暂停、恢复、停止、取消某个节点或翻译源的调用、重试某个节点或翻译源（需求 04 第 7 节） |

触发信息按入口用法而定：持续屏幕给出用户选定的采集范围；划词给出触发的端口，以及界面注入的翻译单元（[工作流定义](03-workflow.md) 5.2）；图片问 AI 的对话用法给出用户选择的图片来源；浮卡复用时给出浮卡标识。

运行协调器发送：

| 消息 | 内容 |
| --- | --- |
| `RunStatus` | 运行状态的变化，取值为 [运行协调器](04-run-coordinator.md) 2.1 的六种状态 |
| `PreflightFailed` | 运行前检查没有通过：哪个节点、哪一项 |
| `NodeNotice` | 运行详情中的重要事件摘要，供主程序在运行详情页实时刷新 |

`Run` 的流因为连接中断而结束时：持续屏幕运行转为暂停，运行协调器在宽限期内保留它，主程序重新连上后用 `Attach` 接上；单批次运行直接结束（[运行协调器](04-run-coordinator.md) 第 12 节）。

```proto
package sth.coordinator.v1;

message RunClientMessage {
  oneof msg {
    RunStart start = 1;
    Control control = 2;
  }
}
message RunStart {
  string run_id = 1;
  bytes workflow = 2;                       // 工作流文档，UTF-8 编码的 JSON
  string entry = 3;                         // screenshot、continuous、selection、image_dialog、image_hint
  string device_id = 4;
  oneof trigger {
    sth.capture.v1.CaptureRange continuous_range = 5;
    SelectionTrigger selection = 6;
    ImageTrigger image = 7;
  }
  optional string reuse_card_id = 8;
}
message SelectionTrigger {
  enum Port { PORT_UNSPECIFIED = 0; TRANSLATE = 1; ASK_AI = 2; }
  Port port = 1;
  optional sth.model.v1.Unit injected = 2;  // 界面注入的翻译单元；缺省时调用取词服务
}
message ImageTrigger {
  enum Source { SOURCE_UNSPECIFIED = 0; SCREENSHOT = 1; SCREEN = 2; MOUSE_REGION = 3; }
  Source source = 1;
}
message Control {
  oneof action {
    bool pause = 1;
    bool resume = 2;
    bool stop = 3;
    NodeAction cancel = 4;
    NodeAction retry = 5;
  }
}
message NodeAction { string node_id = 1; }

message RunServerMessage {
  oneof msg {
    RunStatus status = 1;
    PreflightFailed preflight_failed = 2;
    NodeNotice node_notice = 3;
  }
}
message RunStatus {
  enum State {
    STATE_UNSPECIFIED = 0; PREPARING = 1; RUNNING = 2; PAUSED = 3;
    COMPLETED = 4; STOPPED = 5; FAILED = 6;
  }
  State state = 1;
  optional string reason = 2;
}
message PreflightFailed { string node_id = 1; string problem = 2; }
message NodeNotice { string node_id = 1; string kind = 2; string message = 3; }

message AttachRequest { string run_id = 1; }   // Attach 流的第一条消息，之后与 Run 相同
```

显示事件中的 `RunState` 只有运行中、暂停、停止三种，它描述的是显示端需要知道的状态；`RunStatus` 是运行协调器向主程序报告的完整状态。

## 17 服务注册：`registry`

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `Register` | 双方连续收发 | 后台服务登记自己；主程序登记这台电脑开放的服务和全部本机服务的目录，开放范围变化、本机服务登记或注销时发送新的列表。流关闭即注销 |
| `Query` | 一问一答 | 按接口名、位置查询服务及其描述，供节点编辑器和运行前检查使用 |
| `Watch` | 服务端连续回复 | 订阅服务和设备的变化：登记、注销、设备上线、设备离线、设备已撤销、费用上限变化 |
| `ReportUsage` | 一问一答 | 执行计量的服务每次调用结束后报告用量 |
| `GetUsage` | 一问一答 | 按设备、服务、目标主机和计费周期查询用量，供网页端显示，也供计量服务重启后读回本周期的用量 |

运行协调器在运行期间订阅 `Watch`，据此维护每个服务实例的可用状态，判断整体不可用何时恢复（[运行协调器](04-run-coordinator.md) 6.3）。

"设备已撤销"与"设备离线"分开：服务注册订阅 `auth.WatchRevocations`（第 18 节），某台电脑被撤销时，删除它登记的全部服务，并发出"设备已撤销"。运行协调器收到后，立即停止这台电脑发起的运行，不进入断连的宽限期（[运行协调器](04-run-coordinator.md) 第 12 节）。

"费用上限变化"来自工作流与配置存储：服务注册订阅 `config.WatchServiceSettings`（第 20 节），后台服务的设置变化时，重新计算生效的上限并发出这个事件。电脑上的服务，生效的上限随主程序发布的列表一起更新。

主程序登记的"本机服务目录"只含描述，不可调用：它让网页端的节点编辑器为 `local` 绑定列出候选服务（[网页端](13-web.md) 5.2）。`Query` 的结果为每个服务标明能否调用，以及生效的并发上限和速率上限：服务描述中的默认值，被用户调低的值覆盖。后台服务的调低值来自第 20 节的设置，电脑开放的服务的生效上限由主程序在 `AgentPublish` 中给出。

服务描述的字段见 [服务协议](08-service-protocol.md) 第 12 节，编码如下：

```proto
package sth.registry.v1;

message ServiceManifest {
  string name = 1;
  string display_name = 2;
  repeated InterfaceVersion interfaces = 3;
  Engine engine = 4;
  Languages languages = 5;
  Platform platform = 6;
  Limits limits = 7;
  bool streaming = 8;
  enum Metering { METERING_UNSPECIFIED = 0; NONE = 1; CALLS = 2; CHARACTERS = 3; TOKENS = 4; }
  Metering metering = 9;
}
message InterfaceVersion { string name = 1; uint32 major = 2; uint32 minor = 3; }
message Engine { string id = 1; string name = 2; string version = 3; }
message Languages {
  repeated string ocr = 1;                  // OCR 识别语言
  repeated string source = 2;               // 翻译的源语言
  repeated string target = 3;               // 翻译的目标语言
  bool detects_source = 4;                  // 能否自行判断源语言
}
message Platform {
  string os = 1;                            // windows、macos、linux
  string arch = 2;                          // x86_64、aarch64
  repeated string accelerators = 3;         // cpu、cuda、coreml、directml、metal
}
message Limits {
  uint32 max_concurrency = 1;
  float requests_per_second = 2;
  uint32 burst = 3;
  uint32 max_units_per_request = 4;
  uint32 max_chars_per_request = 5;
}

message RegisterMessage {                  // Register 流中由登记方发送
  oneof msg {
    ServiceManifest service = 1;            // 后台服务登记自己
    AgentPublish agent = 2;                 // 主程序登记开放的服务和本机服务目录
  }
}
message AgentPublish {
  repeated PublishedService exposed = 1;    // 可以调用
  repeated ServiceManifest catalog = 2;     // 只用于节点编辑器列出候选，不可调用
}
message PublishedService {
  ServiceManifest manifest = 1;
  Limits effective_limits = 2;              // 这台电脑上的设置覆盖默认值之后
}

message UsageQuery {
  optional string device = 1;
  optional string service = 2;
  optional string target_host = 3;          // 只对自定义 HTTP 请求服务有意义
  optional string period = 4;               // 计费周期，例如 2026-10；不填为当前周期
}
message UsageRecord {
  string device = 1;
  string service = 2;
  string target_host = 3;                   // 不按主机计量的服务为空
  string period = 4;
  uint64 calls = 5;
  uint64 units = 6;                         // 按服务的计量方式：调用次数、字符或词元
}
message UsageReply { repeated UsageRecord records = 1; }

message ServiceInfo {                       // Query 的结果
  sth.wire.v1.Address address = 1;
  ServiceManifest manifest = 2;
  bool available = 3;
  bool callable = 4;
  Limits effective_limits = 5;              // 默认值被用户调低的值覆盖之后
}
```

## 18 账号与认证：`auth`

登录和配对发生在调用方还没有凭据的时候，所以用普通的 HTTPS 接口，其余操作走服务协议。

| HTTPS 接口 | 请求 | 结果 |
| --- | --- | --- |
| `POST /api/login` | 账号、密码，以及开启了二步验证时的验证码或恢复码 | 设置会话 Cookie（[安全](11-security.md) 2.6） |
| `POST /api/logout` | 无 | 注销当前会话 |
| `POST /api/pair` | 配对码、电脑名称、设备公钥 | 设备标识和后台标识（[安全](11-security.md) 3.1） |

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `CreatePairingCode` | 一问一答 | 生成配对码 |
| `ListDevices`、`RenameDevice`、`RevokeDevice` | 一问一答 | 管理电脑（需求 05 第 3.4 节） |
| `ListSessions`、`RevokeSession` | 一问一答 | 管理会话（需求 05 第 5 节） |
| `ChangePassword` | 一问一答 | 修改密码，其他会话随即失效 |
| `BeginTotp`、`ConfirmTotp`、`DisableTotp`、`RegenerateRecoveryCodes` | 一问一答 | 二步验证与恢复码 |
| `VerifyDevice`、`VerifySession` | 一问一答 | 设备连接与中转在握手时调用，验证设备签名和浏览器会话 |
| `WatchRevocations` | 服务端连续回复 | 推送撤销：被撤销的电脑，以及失效的会话。设备连接与中转、服务注册和观看分发订阅 |

`VerifyDevice` 和 `VerifySession` 只在握手时调用，已经建立的连接要靠 `WatchRevocations` 断开。以下情况发生时，账号与认证在同一个事务中改好数据库，再推送一条撤销：

| 情况 | 推送的内容 |
| --- | --- |
| 主人撤销某台电脑 | 这台电脑的设备标识 |
| 主人注销某个会话 | 这个会话的标识 |
| 修改密码 | 除当前会话外的全部会话 |
| 在服务器上用命令行重置密码或二步验证 | 全部会话 |
| 会话到达空闲超时或绝对有效期 | 这个会话的标识 |

订阅者收到后各自处理：设备连接与中转立即关闭相应的连接（[后台平台服务](10-backend.md) 第 2 节）；服务注册删除被撤销电脑登记的服务，并经 `Watch` 发出"设备已撤销"（第 17 节）；观看分发让被撤销电脑的来源立即下线（[后台平台服务](10-backend.md) 5.2）。订阅流断开后重新订阅时，先收到全部当前有效的撤销，再收到之后的变化，期间漏掉的撤销因此不会遗漏。

注销会话、修改密码和命令行重置，同时作废相应浏览器的"已知浏览器"标记（[安全](11-security.md) 2.2）。

```proto
package sth.auth.v1;

message Revocation {
  oneof target {
    string device_id = 1;                   // 被撤销的电脑
    string session_id = 2;                  // 失效的会话
  }
}
```

`BeginTotp` 返回新的密钥和 `otpauth://` 地址，网页端据此显示二维码；用户用验证器给出的口令调用 `ConfirmTotp` 后，二步验证才生效，同时返回恢复码。这一步确认防止用户在验证器没有正确添加时就开启二步验证、把自己锁在门外。

## 19 观看分发：`viewer`

| 方法 | 形态 | 调用者 | 用途 |
| --- | --- | --- | --- |
| `Publish` | 客户端连续发送 | 运行协调器 | 发布一路来源的批次画面和显示事件 |
| `SetSharing` | 一问一答 | 主程序 | 报告这台电脑的屏幕共享开关 |
| `ListSources` | 服务端连续回复 | 浏览器 | 来源列表及其变化 |
| `Subscribe` | 服务端连续回复 | 浏览器 | 订阅一路来源：先收到快照，再收到之后的事件 |
| `GetFrame` | 一问一答 | 浏览器 | 按显示宽度取批次画面 |
| `PublishDialog` | 客户端连续发送 | 运行协调器 | 网页对话面板节点的输出 |
| `SubscribeDialogs` | 服务端连续回复 | 浏览器 | 接收网页对话面板的内容 |

规则：

- 一路来源由 `Publish` 的流确定：流打开、这台电脑的共享开着，来源就出现在列表中；流结束或共享关闭，来源立即下线，快照和画面随即丢弃（需求 05 第 4.3 节）；
- `Publish` 流打开后，运行协调器先发送 `PublishStart`，再发送当前的显示快照和当前批次画面，之后才发送事件。运行中途打开共享、断线后重新发布时同样如此：观看分发据此从完整的状态开始，复用段落的原文和位置不会缺失；
- `Publish` 中，批次画面以 `BatchFrame` 消息发送，必须先于引用它的 `batch_start` 事件；
- `GetFrame` 返回宽度为 $\min(w, W)$ 的画面，同一张画面、同一个宽度和质量只编码一次（[显示与排版](07-display.md) 3.1）。浏览器在请求中列出能解码的格式，服务优先返回 WebP；
- `Subscribe` 的流量控制按 [服务协议](08-service-protocol.md) 第 5 节进行。观看端处理得慢、额度耗尽时，观看分发只记下这个订阅者落后了；额度恢复后，先发送一份新的快照，再从最新的状态继续；
- 观看分发订阅 `auth.WatchRevocations`（第 18 节）：某台电脑被撤销时，按 [后台平台服务](10-backend.md) 5.2 关闭共享的同样步骤，让它的来源立即下线；
- `PublishDialog` 和 `SubscribeDialogs` 传送 `DialogMessage`：运行协调器把网页对话面板节点的每一份回答更新，连同运行、节点、发起运行的电脑和轮次一起发出；网页端按运行和节点把回答归到各自的对话中，多次运行同时推送时不会混在一起。

```proto
package sth.viewer.v1;

message PublishMessage {
  oneof msg {
    PublishStart start = 1;
    BatchFrame frame = 2;
    sth.model.v1.DisplayEvent event = 3;
    sth.model.v1.DisplaySnapshot snapshot = 4;
  }
}
message PublishStart {
  string run_id = 1;
  string stream_id = 2;
  string device_id = 3;
  string range_label = 4;                   // 采集范围的说明，显示在来源列表中
  string target_language = 5;
}
message BatchFrame { string image_id = 1; uint64 batch_seq = 2; sth.model.v1.EncodedImage image = 3; }

message SourceList { repeated Source sources = 1; }
message Source { string source_id = 1; string device_name = 2; string range_label = 3; string target_language = 4; }

message SubscribeRequest { string source_id = 1; }
message SubscribeReply {
  oneof msg {
    sth.model.v1.DisplaySnapshot snapshot = 1;
    sth.model.v1.DisplayEvent event = 2;
  }
}

message DialogMessage {
  string run_id = 1;
  string node_id = 2;                       // 网页对话面板节点
  string device_id = 3;                     // 发起运行的电脑
  sth.model.v1.ReplyUpdate reply = 4;       // 其中的 turn 区分轮次
}

message GetFrameRequest {
  string image_id = 1;
  uint32 width = 2;                         // 设备像素
  bool data_saver = 3;
  repeated sth.model.v1.EncodedImage.Format accept = 4;
}
```

## 20 工作流与配置存储：`config`

| 方法 | 形态 | 用途 |
| --- | --- | --- |
| `ListWorkflows`、`GetWorkflow` | 一问一答 | 读取工作流 |
| `SaveWorkflow` | 一问一答 | 保存工作流，附带编辑时的修订号 |
| `DeleteWorkflow` | 一问一答 | 删除工作流 |
| `GetSettings`、`SaveSettings` | 一问一答 | 平台设置，例如后台历史记录的容量上限、全局出站代理 |
| `GetServiceSettings`、`SaveServiceSettings` | 一问一答 | 后台服务的设置：用户调低的并发上限和速率上限，费用上限，单独指定的出站代理 |
| `WatchServiceSettings` | 服务端连续回复 | 订阅服务设置：后台服务订阅自己的设置，服务注册订阅全部后台服务的设置，变化时立即推送 |
| `ListExternalServices`、`SaveExternalService`、`DeleteExternalService` | 一问一答 | 网页端管理后台的 AI 服务，以及后台自定义 HTTP 请求使用的命名凭据（需求 01 第 6 节） |
| `WatchExternalServices` | 服务端连续回复 | 后台的 AI 适配服务和自定义 HTTP 请求服务订阅外部服务配置，包括凭据的内容 |

`SaveWorkflow` 的提交修订号与已保存的修订号不同时，回复中给出冲突和当前的修订号，不覆盖已有内容（[工作流定义](03-workflow.md) 第 1 节）。冲突不算调用失败，以回复内容表示。

保存前，服务按 [工作流定义](03-workflow.md) 6.2 做静态校验，校验结果随回复返回：不通过的工作流照常保存，状态为"编辑中"。

服务设置按服务所在的位置分开保存（需求 04 第 10 节）：

- 后台服务的设置保存在这里。服务注册订阅全部后台服务的设置，算出生效的上限，设置变化时经 `registry.Watch` 发出"费用上限变化"（第 17 节）；执行计量的服务和访问外部网络的服务订阅自己的设置，按其中的费用上限和代理执行；
- 电脑上的服务的设置保存在那台电脑的主程序中，主程序在服务的登记流上把设置下发给它（第 3 节），并在发布给服务注册的列表中带上生效的上限。

两边的设置都通过服务注册的 `Query` 体现为生效的上限，运行协调器据此排队（[运行协调器](04-run-coordinator.md) 7.2）。计费周期按协调世界时的自然月计算，与用量表的周期一致（[后台平台服务](10-backend.md) 第 4 节）。

外部服务配置记录后台的 AI 服务和命名凭据。每个 AI 服务有名称、兼容 OpenAI 聊天补全接口的地址、模型、提供的能力（对话、视觉、翻译）、计量方式和所用凭据的名称；AI 适配服务按这份配置，为每个 AI 服务登记一项服务，配置变化时重新登记（[技术选型](15-tech-selection.md) 第 8 节）。命名凭据供后台的自定义 HTTP 请求按名称引用（第 15 节）。`ListExternalServices` 只返回凭据的名称，不返回内容；凭据的内容只经 `WatchExternalServices` 交给 AI 适配服务和自定义 HTTP 请求服务，网页端保存后不再显示（[安全](11-security.md) 7.2）。

```proto
package sth.config.v1;

message ServiceSettings {
  sth.wire.v1.Address service = 1;
  optional sth.registry.v1.Limits lowered_limits = 2;  // 用户调低的上限，只能低于默认值
  optional CostCap cost_cap = 3;
  repeated HostCostCap host_caps = 4;                  // 自定义 HTTP 请求按目标主机设置
  optional ProxySetting proxy = 5;                     // 不填时使用全局设置
}
message CostCap {
  enum Unit { UNIT_UNSPECIFIED = 0; CALLS = 1; CHARACTERS = 2; TOKENS = 3; }
  Unit unit = 1;
  uint64 limit = 2;                                    // 每个计费周期的上限
}
message HostCostCap { string host = 1; CostCap cap = 2; }
message ProxySetting {
  enum Mode { MODE_UNSPECIFIED = 0; GLOBAL = 1; DIRECT = 2; CUSTOM = 3; }
  Mode mode = 1;
  optional string url = 2;                             // CUSTOM 时为 http:// 或 socks5:// 地址
}

message ExternalService {
  string name = 1;
  oneof kind {
    AiService ai = 2;
    NamedCredential credential = 3;
  }
}
message AiService {
  string base_url = 1;
  string model = 2;
  repeated string capabilities = 3;                    // llm、vision、translate
  sth.registry.v1.ServiceManifest.Metering metering = 4;
  string credential_name = 5;
}
message NamedCredential {
  optional string value = 1;                           // 只出现在保存请求和 WatchExternalServices 中
}
```

## 21 历史记录存储：`history`

| 方法 | 形态 | 调用者 | 用途 |
| --- | --- | --- | --- |
| `Upload` | 客户端连续发送 | 主程序、浏览器 | 上传历史记录条目：主程序上传本机的记录，浏览器上传网页对话面板中的对话 |
| `List` | 一问一答 | 浏览器、主程序 | 按种类、时间、是否保留分页列出 |
| `Get` | 一问一答 | 浏览器、主程序 | 读取一条记录的完整内容 |
| `Delete`、`SetPinned` | 一问一答 | 浏览器、主程序 | 删除记录、标记保留 |
| `Clean` | 一问一答 | 浏览器、主程序 | 按时间或种类手动清理 |
| `WatchChanges` | 服务端连续回复 | 主程序 | 接收在网页端发生的删除和保留标记变化，同步本机的对应副本 |

规则：

- 条目标识为第 7 版 UUID，由产生记录的一方生成：桌面端的记录由主程序生成，网页对话面板中直接发起的对话由网页端生成，设备标识记为后台。主程序上传的条目，标识已经存在时跳过，重复上传不会产生两份记录；
- 网页对话每轮回答完成后，网页端就用同一个标识上传一次整段对话，后台用新内容覆盖原来的条目。页面被关掉或网络中断，最多丢失还没有完成的那一轮，重新上传也不会产生重复条目；
- 主程序连着后台时，每保存一条记录就上传一条；上传失败的，以及独立使用时产生的记录，在下次连接时补传（需求 01 第 8 节）；
- 写入时超过容量上限，从最旧的记录开始删除，标记为保留的记录不删除。容量清理只删除后台自己的副本，不通知电脑（需求 01 第 8 节）；
- 用户在网页端删除记录，或者按时间、种类手动清理，后台删除自己的副本，手动清理跳过标记为保留的记录；被删除的记录来自某台电脑时，再通知这台电脑删除本机副本。用户在网页端标记或取消保留，同样通知来源电脑。电脑当时不在线的，下次连接时经 `WatchChanges` 收到；
- 用户在桌面端删除、手动清理或改变保留标记时，主程序对已经上传的记录调用 `Delete`、`SetPinned`，同步后台的副本；离线时记下，连上后补做。后台产生的记录没有本机副本，不发通知。
