# 技术选型

对应需求：[产品需求](../requirements/01-product.md) 第 2、3、9 节，[服务拆分](../requirements/06-services.md)，[桌面平台](../requirements/07-desktop-platforms.md)，README 的开发原则和许可。

本文记录选定的语言、框架、引擎和模型，以及每一项的许可和选择理由。所有事实在 2026-10-14 核实，来源是官方仓库的许可文件、官方文档、模型卡和包注册表；未能核实的事项标为"未核实"，列入第 13 节，在原型阶段确认。

## 1 许可规则

本项目采用 AGPL-3.0 与商业许可双授权。商业许可要求仓库所有者能以 AGPL 之外的条款发行整个程序，第三方代码和模型因此按以下规则引入：

1. 复制进仓库或作为库链接的代码，只能是 MIT、BSD、Apache-2.0、ISC、Zlib 等宽松许可，或者公有领域；
2. GPL、AGPL、LGPL 项目只能作为独立进程或外部服务，通过接口调用；
3. MPL-2.0 只接受 Firefox Translations 的 Bergamot 推理代码和模型。它们只出现在独立的翻译服务进程中：模型文件原样分发；推理代码为了编译和集成而修改的文件，以 MPL 公开修改后的源码；两者都注明源码出处（见 7.1）；
4. 模型权重单独核对许可。禁止商业使用，或者带有地域、用户数、用途限制的权重，不随安装包和镜像预置。

第 3 条是 2026-10-14 确定的。MPL-2.0 是只约束到文件一级的弱 copyleft 许可：第 3.3 条允许 MPL 文件与其他文件组成"更大作品"，按自己选择的条款发行，所以 AGPL 版和商业版都成立；义务是以可执行形式分发时，告诉接收者从哪里取得这些 MPL 文件的源码，并且不删改许可声明。

## 2 语言与总体结构

| 部分 | 语言 | 理由 |
| --- | --- | --- |
| 桌面端主程序、Windows 系统集成 | Rust（Tauri 2、windows-rs） | 见第 3 节 |
| macOS 系统集成中调用原生接口的部分 | Swift，编成静态库供主程序调用 | 屏幕采集、辅助功能接口和窗口列表都是 Swift 和 Objective-C 的原生接口；其余部分与 Windows 共用 Rust，划分见 3.3 |
| 运行协调器、处理服务、后台平台服务 | Rust | 与桌面端共用一套代码：数据模型、服务协议、变化检测和归一化都写成库，桌面端的本机进程和后台容器链接同一份 |
| 界面 | TypeScript 与 React | 网页端、桌面端主窗口和节点编辑器共用一套前端 |

整个项目只用三种语言。服务协议、数据模型、变化检测这些核心逻辑只写一份 Rust 实现，同时编进 Windows、macOS 的本机进程和 Linux 容器，需求 06 第 3.2 节"同一份实现提供两种部署形式"由此成立。

Rust 的四个构建目标都是第 1 级支持的平台：Windows x64（MSVC）、macOS arm64、Linux x86_64 和 aarch64。为 Apple 目标交叉编译需要 macOS SDK；macOS 的发行版本来就要在 Mac 上签名和公证，构建也放在 macOS 的持续集成机器上。

## 3 桌面端

### 3.1 主程序外壳：Tauri 2

主程序使用 Tauri 2（MIT 或 Apache-2.0，核实到 2.12.3）。依据如下：

- 界面跑在系统自带的网页视图里：Windows 用 WebView2，macOS 用 WKWebView。主窗口的操作面板、历史面板、设置和模型管理与网页端共用一套前端，节点编辑器"只做网页版、桌面端内嵌"（需求 02 第 1 节）没有额外成本；
- 本机覆盖层、截图浮卡和网页观看端都用网页技术绘制，[显示与排版](07-display.md) 第 5 节的排版算法只写一份。浏览器的文字排版同时解决了从右往左的文字、竖排和字体回退；
- 体积小。第三方在持续集成中测得空应用约 3 MB（Windows）和 5 MB（macOS），同口径下 Electron 约 385 MB 和 320 MB。WebView2 运行时预装在所有 Windows 11 设备上，默认的联网安装方式不增加安装包体积；
- 需求 07 第 2 节要求的窗口能力都有现成实现，已在 Tauri 的窗口库 tao 的源码中核实：托盘、透明、点击穿透（`WS_EX_TRANSPARENT` 加 `WS_EX_LAYERED`）、置顶、不激活（`WS_EX_NOACTIVATE`）、排除截屏（`WDA_EXCLUDEFROMCAPTURE`）；
- macOS 的非激活面板用 tauri-nspanel（Apache-2.0 或 MIT），它提供非激活面板样式、全屏辅助和所有空间可见的集合行为、窗口层级。苹果技术支持确认过的覆盖层设置（需求 07 第 3 节）都能经它设置。

已知问题，上线前处理：

| 问题 | 处理 |
| --- | --- |
| tao 从 0.37.1 起显示窗口时使用 `SW_SHOW`，会激活不可聚焦的窗口，修复尚未合并 | 覆盖层和浮卡取得窗口句柄后，自己用不激活的方式显示 |
| 点击穿透作用于整个窗口，没有转发鼠标移动的选项 | 覆盖层的交互模式按快捷键整体切换（需求 01 第 5.2 节），不需要局部穿透 |
| 有报告称 macOS 打包后仍出现 Dock 图标，问题关闭时没有关联的修复 | 在 macOS 15 以上的打包产物上自测，同时在启动时把激活策略设为 accessory |

窗口的扩展样式由 tao 统一生成，所以窗口属性通过 Tauri 的接口设置，不直接改写样式位，避免两边互相覆盖。[桌面端](12-desktop.md) 3.3 还要求两项设置：不在任务栏和 Alt+Tab 中出现（`WS_EX_TOOLWINDOW`），以及点击浮卡时不激活它（`WM_MOUSEACTIVATE` 返回 `MA_NOACTIVATE`）。前者在 Tauri 有对应接口时经接口设置，没有时由主程序在窗口创建后设置，并在 tao 每次改写扩展样式后重新设置；后者用窗口子类化处理消息，不涉及样式位。两项都列入第 13 节，在原型阶段验证。

### 3.2 Windows 系统集成

Windows 的系统集成服务用 Rust 和 windows-rs（MIT 或 Apache-2.0）实现，在主程序进程内运行：

- 屏幕采集：windows-rs 的 `Graphics::Capture` 模块，覆盖 Windows.Graphics.Capture 的全部类型；
- 取词：UI Automation，可以使用 uiautomation 库（Apache-2.0）。界面自动化的调用是跨进程的同步请求，目标程序无响应时，调用线程会等到超时，默认最长 20 秒，所以取词放在专用的后台线程上，并调低超时；
- 全局快捷键：global-hotkey（MIT 或 Apache-2.0），底层调用 `RegisterHotKey`。

### 3.3 macOS 系统集成

macOS 上必须调用 Swift 和 Objective-C 接口的部分用 Swift 实现，编成静态库，主程序经 swift-rs（MIT 或 Apache-2.0）调用；其余部分与 Windows 一样用 Rust。八项系统集成服务在两个平台上的实现语言如下：

| 服务 | Windows | macOS |
| --- | --- | --- |
| 屏幕采集（含变化检测） | Rust，windows-rs 调用 Windows.Graphics.Capture | Swift 调用 ScreenCaptureKit，采集回调把画面交给 Rust |
| 变化检测算法 | Rust 库 | 同一个 Rust 库 |
| 框选截图 | Tauri 窗口，截图用 Rust | Tauri 窗口，截图用 Swift 调用 `SCScreenshotManager` |
| 取词 | Rust，UI 自动化，可以使用 uiautomation 库 | Swift，辅助功能接口，可以复用 SelectedTextKit（MIT） |
| 本机覆盖层、浮卡与对话面板、鼠标旁提示 | Tauri 窗口，Rust 设置窗口样式 | Tauri 窗口；覆盖层、浮卡和提示经 tauri-nspanel 设置为非激活面板，对话面板是普通窗口 |
| 快捷键与输入事件 | Rust，global-hotkey 调用 `RegisterHotKey` | Rust，global-hotkey 调用 `RegisterEventHotKey`；需要快捷键录制界面时用 KeyboardShortcuts（MIT） |
| 窗口跟踪 | Rust，`SetWinEventHook` | Swift，读取 `CGWindowListCopyWindowInfo` |

需要系统权限的屏幕采集和取词都在主程序进程内执行。苹果员工在开发者论坛说明，系统按"责任代码"归属权限，判定算法是启发式的；有开发者实测，辅助功能权限不会传给包内的普通辅助程序。放在主程序进程内，权限的归属最确定。进程划分的完整规定见 12 桌面端。

### 3.4 落选方案

| 方案 | 落选理由 |
| --- | --- |
| Electron | 空应用约 320 至 385 MB；默认构建带专有编解码器；macOS 27 上点击面板会激活应用，修复尚未合并。Tauri 遇到无法绕过的问题时，它是第一备选 |
| Windows 用 C#/.NET 加 WinUI 3，macOS 用 Swift 加 AppKit | 两套界面各写一份。WinUI 3 没有托盘和透明窗口接口，非打包安装还要另外部署它的运行时；WPF 不能预先编译成原生代码，透明窗口里也显示不了 WebView2 |
| Wails | v2 没有托盘，v3 仍是测试版，没有正式发布的日期 |
| Flutter | 多窗口接口仍是实验性的；Windows 上的网页视图插件约两年没有发布 |
| Avalonia | 官方文档写明不支持点击穿透；界面用 XAML 写，不能与网页端共用 |
| Qt 6 | 每次发行都要履行 LGPL 义务；多个模块只有 GPL 版本；开源版 6.12 的支持在 2027-04-01 结束 |
| .NET MAUI | macOS 上走 Mac Catalyst，菜单栏只能经 Objective-C 运行时实现，AppKit 后端是实验性的 |
| Compose Multiplatform | 要随安装包带 Java 运行时；没有官方的桌面网页视图 |

## 4 服务协议

服务之间、桌面端与后台之间、浏览器与后台之间使用同一套自定义协议：

- 消息格式用 Protocol Buffers 定义。Rust 侧用 prost（Apache-2.0），浏览器侧用 protobuf-es（Apache-2.0）；
- 一条连接上多路复用多个调用，两端都可以发起调用；
- 网络连接走 TLS 上的 WebSocket，本机进程之间走命名管道或 Unix 域套接字，帧格式相同；
- 流量控制按调用分配额度：接收方把数据放进正在重组的消息时补充额度，业务代码没有取走上一条消息时暂停补充，既能传完大消息，又能让慢速的接收方挡住发送方。

选择自定义协议，而不用 gRPC，依据有三条：

1. 后台要经桌面端主动建立的连接反向调用电脑上的服务（[架构](01-architecture.md) 5.2）。gRPC 没有内建的反向调用机制，现成的反向隧道库只有 Go 实现，作者自己称这类用例小众；
2. 浏览器不能直接使用 gRPC。gRPC-Web 和 Connect 协议在浏览器中都只支持一元调用和服务端流，用 gRPC 就要为浏览器另配一套协议；
3. 浏览器的 WebSocket 接口没有背压，消息到达比处理快时会堆积在页面内存里。协议层的额度机制让发送方在接收方处理完之前停止发送，手机上的慢速观看端因此不会被画面淹没。

协议的完整定义见 08 服务协议。WebSocket 的实现用 tokio-tungstenite（MIT），异步运行时用 tokio（MIT），HTTP 服务用 axum（MIT）。

## 5 后台基础组件

| 组件 | 选型 | 许可 | 运行方式 | 理由 |
| --- | --- | --- | --- | --- |
| 网关 | Caddy | Apache-2.0 | 独立容器 | 默认同时启用 HTTP-01 和 TLS-ALPN-01 两种证书质询；支持接收 PROXY 协议头，保留访问者的真实地址；HTTP/2 流式转发不缓冲 |
| 透传中转 | frp | Apache-2.0 | 中转服务器和家里各一个独立进程 | 家里的 frpc 主动连接服务器上的 frps；frps 按 TLS 握手中的服务器名称转发，不解密 |
| 存储 | SQLite，经 rusqlite 访问 | SQLite 为公有领域，rusqlite 为 MIT | 每个平台服务一个数据库文件 | 每个服务独占自己的数据（[架构](01-architecture.md) 3.2）；预写日志模式下读写互不阻塞；在线备份接口可以在服务运行时备份 |
| 密码哈希 | argon2 | MIT 或 Apache-2.0 | 库 | 实现 Argon2id，参数见 [安全](11-security.md) 2.1 |
| 二步验证 | totp-rs | MIT | 库 | 实现 RFC 6238 |
| 设备签名验证 | p256 | MIT 或 Apache-2.0 | 库 | 验证电脑的 ECDSA P-256 签名（[安全](11-security.md) 3.2） |

TLS-ALPN-01 质询经 frp 透传到家里的 Caddy 能够完成，推导如下：

1. RFC 8737 第 3 节规定，验证连接使用 TCP 443 端口，证书颁发机构在 TLS 握手的客户端问候中带上被验证的域名和 `acme-tls/1` 应用层协议标识；
2. 这两项都在明文的客户端问候中。frps 只按其中的服务器名称选择转发目标，把字节原样转发，不检查应用层协议标识；
3. 连接经 frpc 到达家里的 Caddy，Caddy 返回质询证书。握手的两端是证书颁发机构和 Caddy，中转只搬运密文。

这条路径成立需要满足以下条件，写进 14 部署与运维：

- frps 占用中转服务器的公网 443 端口；
- 域名如果有 IPv6 解析，IPv6 地址也指向中转服务器，并且 frps 监听 IPv6：Let's Encrypt 有 IPv6 地址时优先用 IPv6 连接，只有连接超时才退回 IPv4；
- frp 发送 PROXY 协议头时，Caddy 先解析它，再处理 TLS；
- 中转和 Caddy 之间没有任何终止 TLS 的环节。

## 6 OCR

### 6.1 安装包自带

Windows 版和 macOS 版自带同一套引擎：PP-OCRv6 small 的检测模型和识别模型，ONNX 格式，经 ONNX Runtime 在 CPU 上运行。

| 项目 | 内容 |
| --- | --- |
| 模型许可 | Apache-2.0（PaddlePaddle 官方模型卡） |
| 模型体积 | 检测 9.88 MB，识别 21.2 MB，合计约 31 MB |
| 语言 | 简体中文、繁体中文、英文、日文，以及 46 种拉丁字母语言 |
| 运行时 | ONNX Runtime（MIT），1.31.0 提供 Windows x64 和 macOS arm64 版本，macOS 版最低要求 macOS 14 |
| Rust 绑定 | ort（MIT 或 Apache-2.0）。当前只有 2.0 的候选版本，接口在正式版之前还会变化 |
| 前后处理 | 图像预处理、文字检测的后处理和识别结果的解码，参照 RapidOCR（Apache-2.0）的实现移植到 Rust，保留它的版权声明 |

选 PP-OCRv6 small 的依据是 PaddlePaddle 在同一套评测集上公布的识别准确率：

| 识别模型 | 屏幕文字 | 印刷英文 | 日文 |
| --- | --- | --- | --- |
| PP-OCRv5 mobile | 57.6% | 86.0% | 75.8% |
| PP-OCRv5 server | 68.1% | 85.1% | 73.7% |
| PP-OCRv6 small | 79.7% | 93.3% | 88.2% |

屏幕截图正是本产品的输入。PP-OCRv6 small 的屏幕文字准确率比 PP-OCRv5 mobile 高 22.1 个百分点，也高于体积约为它四倍的 PP-OCRv5 server。

### 6.2 按需下载

PP-OCRv6 有两个缺口：不识别韩文和阿拉伯文，官方也没有竖排文字的说明。以下模型在模型管理中按需下载：

| 用途 | 模型 | 许可 | 体积 |
| --- | --- | --- | --- |
| 韩文 | PP-OCRv5 韩文识别模型 | Apache-2.0 | 14 MB |
| 阿拉伯文 | PP-OCRv5 阿拉伯文识别模型 | Apache-2.0 | 7.6 MB |
| 竖排文字（非漫画） | PP-OCRv5 的检测和识别模型。官方写明支持竖排，识别模型在"竖直文本"一项的准确率为 server 0.9314、mobile 0.8089 | Apache-2.0 | mobile 合计约 21 MB |
| 漫画文字区域检测 | comic-text-and-bubble-detector 的 int8 版本，检测对白框、框内文字和框外文字 | Apache-2.0 | 43.8 MB |
| 漫画文字识别 | manga-ocr，支持竖排、振假名和多行对白一次识别 | 代码和权重均为 Apache-2.0 | 444 MB（PyTorch 格式），由项目自行导出为 ONNX |

两个漫画模型的附加条件：

- manga-ocr 的训练数据 Manga109-s 允许把训练结果用于商业目的，条件是发布时写明使用了这份数据集。模型管理的说明和项目的第三方声明中都要写明；
- comic-text-and-bubble-detector 的模型卡没有写训练数据的来源。首版采用它，同时把训练数据来源列入第 13 节，在原型阶段向作者确认；确认不了时，改用 PP-OCRv5 的检测模型输出文字行，再按列间距合并成对白块，这条退路的许可是 Apache-2.0，没有同样的问题。

下载的模型按引擎归入服务（需求 06 第 1 节"同一类能力的不同引擎各是一个服务"）：

- 韩文和阿拉伯文只换识别模型，文字检测仍用 PP-OCRv6 small 的检测模型，与 6.3 节后台的做法相同。这两个识别模型下载后加入自带 OCR 服务的识别语言，服务随即重新登记（[服务协议](08-service-protocol.md) 第 12 节）。识别语言为自动时只用默认的 PP-OCRv6 small 识别模型；要识别韩文或阿拉伯文，用户在 OCR 节点上选定这种语言，服务按语言换用识别模型；
- 竖排文字的 PP-OCRv5 模型和漫画 OCR 各是一项单独的 OCR 服务，检测和识别都用自己的模型，用户把 OCR 节点绑定到它们。

阿拉伯文的识别结果要按 Unicode 双向算法从显示顺序转为逻辑顺序。RapidOCR 为此使用的 python-bidi 是 LGPL，不能在进程内使用；本项目用 unicode-bidi（MIT 或 Apache-2.0）。

### 6.3 后台

后台的 OCR 服务与桌面端是同一份 Rust 实现，默认模型换成准确率更高的 PP-OCRv6 medium（检测 62 MB，识别 76.6 MB），韩文和阿拉伯文同样使用 PP-OCRv5 的识别模型。镜像同时提供 amd64 和 arm64 两种架构：ONNX Runtime 1.31.0 提供 Linux x86_64 和 aarch64 两种版本。

PaddleOCR-VL-1.6（Apache-2.0）作为可选服务，放在编排文件的 `gpu` 配置组中（[部署与运维](14-deployment.md) 第 2 节）。它自带版面分析和阅读顺序，在技术报告的竖排文本类别中误差最低，适合双栏论文和复杂文档；代价是权重约 1.9 GB，吞吐要靠 GPU。

### 6.4 系统 OCR

系统 OCR 不占安装包体积，首版只提供 Windows 的一种：

- Windows.Media.Ocr：可用语言取决于用户安装的 OCR 语言包；微软官方示例的注释写明，竖排只支持繁体中文和日文；
- Apple Vision：留到后续版本。`RecognizeTextRequest` 是 Swift 接口，首版的处理服务都是 Rust 程序（第 2 节），没有地方运行它。官方文档没有竖排文字的说明，开发者论坛有竖排中文识别失败的报告。

Windows.Media.Ocr 是 WinRT 接口，Rust 经 windows-rs 可以直接调用，以 Rust 程序的本机进程运行，只在 Windows 上提供（需求 06 第 3.2 节）。

### 6.5 落选的引擎

| 引擎 | 落选理由 |
| --- | --- |
| comic-text-detector | 代码是 GPL-3.0，权重没有许可声明，文字块检测器用 AGPL-3.0 的 YOLOv5 仓库训练 |
| Surya | 权重许可规定，营收或融资超过 500 万美元的使用者不得商用，另有竞争条款 |
| EasyOCR | 不支持竖排中日文；权重没有许可声明；最后一次发布在 2024-09 |
| docTR | 官方没有中日韩和阿拉伯文的预训练模型 |
| Windows App SDK 的文字识别 | 只能在 Copilot+ PC 的 NPU 上运行 |
| Tesseract 5 | 许可和体积合适，但没有 GPU 加速，官方没有精度数据，竖排日文依赖二值化等预处理 |

## 7 翻译

### 7.1 安装包自带

Windows 版和 macOS 版自带 Bergamot 引擎和英中互译的两个模型，模型来自 Firefox Translations：

| 项目 | 内容 |
| --- | --- |
| 推理代码 | mozilla/translations 仓库 inference 目录中的代码（MPL-2.0），其中的 Marian 内核为 MIT |
| 模型 | 英译简体中文、简体中文译英，均为 Firefox 已发布的 base-memory 版本，int8 格式 |
| 模型许可 | MPL-2.0（mozilla/translations 的说明："The model files are distributed under the MPL 2.0 license"） |
| 体积 | 两个模型文件合计约 88 MB（43,849,787 字节和 43,977,787 字节），词表和词汇短名单另计，大小未核实 |
| 质量 | Firefox 模型注册表中的 COMET22 分数：英译中 0.8628，中译英 0.8596。COMET22 是用神经网络评估译文质量的指标，越高越好 |
| 运行方式 | 纯 CPU 的 int8 推理 |

选 Bergamot 的依据是速度。持续屏幕翻译的首选源默认就是这个自带引擎（需求 02 第 2 节），它要在普通电脑的 CPU 上跟上画面。translateLocally 的论文实测了 Bergamot 的英译德小模型：2012 年的双核笔记本处理器上每秒 1066 词，同条件下 Argos Translate 每秒 76 词。Mozilla 没有公布中日韩模型的测速，原型阶段实测。

MPL-2.0 的义务这样履行：

- 这部分代码和模型只编进独立的 Bergamot 翻译服务进程，不与其他服务的代码组合；
- 原样分发 Mozilla 发布的模型文件，项目的第三方声明列出每个 MPL 文件的源码地址；
- 对 MPL 文件的修改，以 MPL 公开源码。

Bergamot 依赖的句子切分库 ssplit-cpp 中有一个目录是 LGPL-2.1，库本身也声明不支持中日韩字符。这个库不进入构建，句子切分由项目自己实现。

### 7.2 按需下载

| 模型 | 许可 | 体积 | 用途 |
| --- | --- | --- | --- |
| Firefox 的日译英、韩译英、阿拉伯文译英 | MPL-2.0 | 每个约 32 至 44 MB | 与英译中串联，完成日、韩、阿拉伯文译中。Firefox 的翻译只用英文作中间语言 |
| Hy-MT2-1.8B，GGUF 格式 | Apache-2.0 | Q4_K_M 1.13 GB，Q8_0 1.91 GB | 五个方向都一步译出，不经英文 |
| Hy-MT2-7B，GGUF 格式 | Apache-2.0 | Q4_K_M 4.62 GB | 有独立显卡或 Apple 芯片的电脑 |
| Qwen3.5 小尺寸、Gemma 4 小尺寸 | Apache-2.0 | 按尺寸 | 需要上下文、术语或风格控制时作为 AI 翻译源 |
| macOS 系统翻译 | 系统框架 | 由系统下载 | 留到后续版本。macOS 15 上只能经 SwiftUI 的 `translationTask` 取得翻译会话，macOS 26 起才能直接创建；首版的翻译服务是不带界面的 Rust 程序，取不到会话（需求 07 第 1.2 节） |

GGUF 是 llama.cpp 使用的模型文件格式，Q4_K_M、Q8_0 是它的量化等级，数字大致等于每个权重占用的位数。GGUF 模型由 llama.cpp（MIT）的 llama-server 以独立进程运行，翻译服务通过它的 HTTP 接口调用。

Hy-MT2 是腾讯 2026-05-21 发布的翻译模型。它的技术报告在 FLORES-200（Meta 发布的 200 种语言评测集）上用 XCOMET-XXL（用神经网络给译文打分的指标，越高越好）评分，1.8B 版中文与其他语言互译的平均分为 84.26，同表 Microsoft Translator 为 82.95。

大语言模型在纯 CPU 上的速度受内存带宽限制。稠密模型每生成一个词元，都要把全部权重从内存读一遍；设权重占 $M$ 字节、内存带宽为 $B$ 字节每秒，每秒生成的词元数满足：

$$
\text{词元/秒} \le \frac{B}{M}
$$

DDR4-3200 双通道内存的理论带宽为 $2 \times 8\,\text{B} \times 3.2 \times 10^9\,\text{s}^{-1} = 51.2\ \text{GB/s}$，Hy-MT2-1.8B 的 Q4_K_M 文件为 1.133 GB，所以：

$$
\text{词元/秒} \le \frac{51.2}{1.133} \approx 45
$$

一行 30 个词元的译文至少要 0.66 秒，实际还要加上处理输入的时间。这就是自带引擎选 Bergamot、而把 Hy-MT2 作为下载选项的原因。

### 7.3 后台

后台的默认翻译服务是 llama.cpp 的 llama-server 加 Hy-MT2-1.8B。服务器有显卡、启用了 `gpu` 配置组时，另有 Hy-MT2-7B 在显卡上运行，作为另一项翻译服务登记（[部署与运维](14-deployment.md) 第 2 节）。llama.cpp 的官方镜像同时提供 amd64 和 arm64，模型是 Apache-2.0，可以预置进镜像，镜像中附上模型的许可文件。

### 7.4 落选的模型

| 模型 | 落选理由 |
| --- | --- |
| NLLB-200 | 权重为 CC-BY-NC-4.0，禁止商用 |
| Sakura | 权重为 CC BY-NC-SA 4.0，禁止任何形式的商用；只能日译中 |
| Hunyuan-MT-7B、HY-MT1.5 | 许可协议在欧盟、英国和韩国不适用，自部署产品无法控制用户所在地；禁止用输出改进其他模型。同一团队的 Hy-MT2 已改用 Apache-2.0 |
| Qwen2.5-3B | 研究许可，只允许非商业用途 |
| Gemma 3、TranslateGemma | 使用条款要求把使用限制写进与下游的协议，Google 保留远程限制使用的权利 |
| Llama 3.x | 官方支持的语言不含中日韩和阿拉伯文 |
| Argos Translate 的日、韩、阿拉伯文模型包 | 包内没有许可声明，询问能否商用的问题没有维护者回复 |
| OPUS-MT | 日、韩、阿拉伯文译中同样要经英文，单个模型 312 至 418 MB，体积和质量都不如 Firefox 模型 |

### 7.5 语言识别

源语言为 `auto` 时，运行协调器为没有语言信息的段落识别语言（[运行协调器](04-run-coordinator.md) 3.4）。识别库选 lingua（lingua-rs，Apache-2.0，核实到 1.8.0）：它的说明写明适合短文本和多种语言混合的文本，屏幕上的界面文字正是这种短文本。另一个候选 whatlang（MIT，0.18.0）更轻量，作为体积不够时的备选。lingua 按语言提供模型，只编入平台支持的语言，体积在原型阶段测量（第 13 节）。

自带的 Bergamot 不能自行判断源语言，它的服务描述中 `detects_source` 为假；每一段的语言由上面的识别结果确定，Bergamot 据此选择模型，日、韩、阿拉伯文先译成英文再译成中文。

## 8 AI

AI 对话、视觉 AI 和 AI 翻译源由同一个 AI 适配服务接入，它调用兼容 OpenAI 聊天补全接口的服务。外部的 AI 服务商、本机或后台运行的 llama-server、Ollama 都提供这种接口，一个适配服务就能覆盖。每个配置好的 AI 服务登记为一项服务（需求 06 第 1 节"同一类能力的不同引擎各是一个服务"），费用上限的计量也在适配服务中完成（[服务接口](09-service-interfaces.md) 第 14 节）。

后台的 AI 服务在网页端配置，保存在工作流与配置存储，AI 适配服务启动时读取并订阅变化（[服务接口](09-service-interfaces.md) 第 20 节）；电脑上的 AI 服务在那台电脑的桌面端配置（需求 01 第 6 节）。

## 9 网页端

| 用途 | 选型 | 许可 | 理由 |
| --- | --- | --- | --- |
| 界面框架 | React 19 | MIT | 由节点编辑器库决定 |
| 节点编辑器 | React Flow（@xyflow/react 12） | MIT | 候选中维护最活跃，2026 年 8、9 月接连发布；官方声明会一直保持 MIT |
| 消息编码 | protobuf-es | Apache-2.0 | 与服务协议共用 Protocol Buffers 定义 |

其他节点编辑器库落选：Rete.js 的核心包在 2025-06 之后没有新版本；LiteGraph 的原仓库 2024-01 之后没有提交，仍在维护的分支已并入一个 GPL-3.0 仓库；Drawflow 2024-09 之后没有提交；Vue Flow 2026-01 之后只有文档提交。

## 10 图片编码

观看端的批次画面用有损 WebP，JPEG 作回退：

- WebP：libwebp（BSD-3-Clause，另附 Google 的专利许可），经 libwebp-sys（MIT）静态链接。Google 公布的数据是，同等结构相似度下，有损 WebP 比 JPEG 小 25% 到 34%。iOS Safari 14、Chrome 32、Firefox 65、Edge 18 起完整支持 WebP 解码；
- JPEG：jpeg-encoder（MIT 或 Apache-2.0，并含 IJG 许可的部分）。按 IJG 许可，只分发可执行程序时，文档要写明"this software is based in part on the work of the Independent JPEG Group"；
- AVIF 暂不进入观看路径：iOS 16、Safari 16.4、Edge 121 起才支持解码，编码耗时与 WebP 的对比没有官方数据。

## 11 家庭部署的异地访问

没有服务器的部署者，首版不提供异地访问方案，部署说明建议他们使用离线版，即桌面端独立使用（需求 01 第 2.2 节）。平台不推荐任何组网工具。

## 12 许可义务清单

发行时履行以下义务，内容写进安装包和镜像附带的第三方声明：

| 来源 | 义务 |
| --- | --- |
| Apache-2.0 的代码和模型（PP-OCR 模型、RapidOCR 移植部分、manga-ocr、Hy-MT2 等） | 附许可文本；保留版权和署名；转换格式或修改过的文件标明修改 |
| MPL-2.0（Bergamot 推理代码、Firefox 模型） | 注明每个文件的源码地址；不删改许可声明；修改过的文件以 MPL 公开源码 |
| Manga109-s 训练的 manga-ocr | 写明使用了 Manga109-s 数据集 |
| libwebp | 附 BSD-3-Clause 许可文本和 Google 的专利许可 |
| jpeg-encoder | 文档写明基于 Independent JPEG Group 的工作 |
| MIT、BSD 的库 | 附许可文本和版权声明 |

## 13 原型阶段要验证的事项

| 事项 | 影响 |
| --- | --- |
| mozilla/translations 的推理代码能否在 Windows x64 和 macOS arm64 上原生编译，并加载 base-memory 模型 | 7.1 |
| Firefox 模型的词表和短名单大小，安装包的最终体积 | 7.1 |
| Bergamot 中日韩阿拉伯文模型在纯 CPU 上的单句延迟，以及经英文串联后的质量 | 7.1、7.2 |
| Hy-MT2 的标准量化模型能否在主线 llama.cpp 上运行。官方 GGUF 说明写有依赖一个尚未合并的补丁 | 7.2、7.3 |
| ort 2.0 正式版的接口 | 6.1 |
| 非打包的 Win32 程序能否申请去掉采集黄框；不能时，用"带外部位置的打包"取得包标识后是否可行 | 需求 07 第 5.1 节 |
| tao 中不可聚焦窗口被激活的问题的修复进度 | 3.1 |
| comic-text-and-bubble-detector 训练数据来源的可接受性 | 6.2 |
| WebView2 运行时、WKWebView、AppKit 在下游再分发 AGPL 版时是否算作"系统库" | 第 1 节 |
| 打包工具链（安装程序生成器等）中进入安装包的部分的许可 | 第 12 节 |
| lingua 编入所需语言后的体积，以及它对短文本的识别准确率 | 7.5 |
| Windows.Graphics.Capture 窗口采集的帧与 `DWMWA_EXTENDED_FRAME_BOUNDS` 的对应关系，以及帧像素与屏幕物理像素的关系，在 100%、125%、150% 和混合缩放下测量 | [桌面端](12-desktop.md) 3.2 |
| 两个平台脏区域的单位、原点和比较基准，Windows 的 `DirtyRegionMode` 的默认值 | [变化检测](05-change-detection.md) 2.4、[桌面端](12-desktop.md) 3.2、4.2 |
| UI 自动化取词超时后返回的错误，以及合适的事务超时取值 | [桌面端](12-desktop.md) 3.5 |
| 让 Chromium 系浏览器和 Electron 应用暴露选中文字的做法 | [桌面端](12-desktop.md) 4.5 |
| Caddy 用 `shortlived` 配置申请 IP 地址证书的实际效果，这个选项在 Caddy 中仍标为实验性 | [部署与运维](14-deployment.md) 4.2 |
| 经 Tauri 设置 `WS_EX_TOOLWINDOW` 的途径，以及在 tao 改写扩展样式后重新设置它的做法；用窗口子类化处理 `WM_MOUSEACTIVATE` 是否与 tao 的消息处理冲突 | 3.1、[桌面端](12-desktop.md) 3.3 |
| 鼠标旁提示显示期间，临时把不带修饰键的 Esc 注册为全局快捷键（`RegisterHotKey`、`RegisterEventHotKey`），并监听全局鼠标按下，在两个平台上的效果 | [桌面端](12-desktop.md) 3.3、4.4 |
| macOS 上让 llama-server 监听 0700 目录中的 Unix 域套接字（`--host` 取以 `.sock` 结尾的路径） | [安全](11-security.md) 第 5 节 |
| llama.cpp 官方带 CUDA 的镜像、PaddleOCR-VL 的部署方式，以及它们提供的处理器架构 | 6.3、7.3、[部署与运维](14-deployment.md) 第 2 节 |
