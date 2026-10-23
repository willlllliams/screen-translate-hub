# screen-translate-hub

screen-translate-hub 是一个自部署的屏幕翻译与 AI 平台。Windows 与 macOS 桌面端负责截图、划词、持续屏幕采集和本机显示，Docker 后台负责账号、设备连接、跨设备中转和服务器侧处理，手机与电脑浏览器负责观看经过翻译或 AI 加工的画面，以及与 AI 对话。

平台的主线场景是持续屏幕翻译：用户在电脑上选定窗口或区域，平台持续识别画面文字，并把译文叠加在原文位置，同时在本机和网页上展示。截图翻译、划词翻译、划词问 AI 和图片问 AI 共用同一套处理能力。

## 当前阶段

第一版（Windows 单机版）已经实现并在真实桌面上跑通，范围见 [第一版范围](docs/requirements/09-v1-scope.md)，实现方式见 [第一版实现](docs/spec/18-v1-implementation.md)，开发中的决定和实测结果记在 [开发记录](docs/dev-log.md)，交付说明见 [方案说明](docs/proposal.md)。第一版包括：

- 单次截图翻译（画在原位或截图浮卡）和持续屏幕翻译（整屏、跟随活动窗口、指针下的窗口），变化检测、段落复用、译文缓存；
- 多翻译源竞速：Claude Code 无头模式、兼容 OpenAI 的接口、Anthropic 接口、Bergamot 离线翻译（Firefox 的引擎和模型）、模拟翻译源；
- 本机覆盖层的两种显示方式（原位底板、整屏压暗）和交互模式，平台窗口不进入采集；
- 局域网网页观看（手机、平板、电脑浏览器），访问码保护；
- AI 助手：心跳截屏、规则门控（另可接 jev）、AI 大脑（Claude Code 或 pi）通过平台工具看屏幕、画标注、在悬浮卡片里回答；
- 本机历史记录。

docs 中其余文档描述的是长期目标（Docker 后台、账号、跨设备、macOS 等），第一版对它们的取舍以第一版范围为准。

## 运行第一版

需要 Windows 11（Windows 10 2004 以上理论上可用，没有测试过）、Node.js 24、Python 3.12。

```powershell
npm install                 # TypeScript 部分和 Electron
npm run setup:py            # .venv 与 Python 服务的依赖（采集、OCR）
npm run desktop             # 构建并启动桌面主程序（托盘图标）
```

默认翻译源是本机已登录的 Claude Code（`claude` 在 PATH 上）加 Bergamot；Bergamot 第一次使用时下载约 50 MB 的模型。快捷键：Alt+Shift+S 截图翻译，Alt+Shift+C 开始或暂停持续翻译，Alt+Shift+H 显示或隐藏覆盖层，Alt+Shift+I 交互模式，Alt+Shift+A AI 助手。手机观看：托盘菜单"Copy viewer link"，在同一网络的手机上打开；第一次运行时 Windows 防火墙会询问是否允许 Node.js 接受连接；也可以在管理员 PowerShell 中运行 `tools/win/allow-viewer.ps1`，只放行观看端口、只在专用网络上放行。

测试：`npm test`（TypeScript 各包）、`npm run test:py`（Python 服务）、`npm run typecheck`。经 SSH 在远程电脑上开发时的工具见 [第一版实现](docs/spec/18-v1-implementation.md) 第 16 节。

## 需求文档

初次了解需求，先读 [使用场景](docs/requirements/08-scenarios.md)：它用五个具体场景说明平台在实际使用中的表现，每个场景都列出对应的需求和规格说明章节。

| 文档 | 内容 |
| --- | --- |
| [术语表](docs/requirements/00-terms.md) | 全部需求文档统一使用的术语及其含义 |
| [产品需求](docs/requirements/01-product.md) | 产品定位、部署形态、客户端、功能入口、展示方式、AI 交互、多语言、历史记录、硬件要求 |
| [工作流](docs/requirements/02-workflow.md) | 工作流与入口的绑定、默认模板、节点编辑规则、执行位置、跨设备数据流向 |
| [OCR 与竞速翻译](docs/requirements/03-ocr-and-translation-race.md) | OCR 引擎选择、识别结果归一化、多翻译源竞速的显示与替换规则 |
| [运行与生命周期](docs/requirements/04-run-lifecycle.md) | 运行、批次、竞速和请求的生命周期，持续屏幕的处理节奏、段落复用与译文缓存，超时、重试、暂停、停止、断连与配置变更 |
| [账号、设备与共享](docs/requirements/05-accounts-devices-sharing.md) | 主人账号、登录与找回、电脑配对与撤销、服务开放、屏幕共享、来源与观看规则、安全与隐私 |
| [服务拆分](docs/requirements/06-services.md) | 服务的分类、拆分原则、运行协调器、部署形式、注册与接口版本 |
| [桌面平台](docs/requirements/07-desktop-platforms.md) | Windows 与 macOS 的最低版本、依赖的系统能力、系统权限、安装分发和平台差异 |
| [使用场景](docs/requirements/08-scenarios.md) | 五个典型场景：用户的操作、平台的响应，以及对应的需求与规格说明章节 |
| [第一版范围](docs/requirements/09-v1-scope.md) | 第一版做什么、不做什么，补充的需求：显示方式切换、同语言不翻译、翻译源、局域网观看、快捷键、AI 助手 |
| [待定事项](docs/requirements/open-questions.md) | 已识别但尚未确定的问题 |

## 规格说明

| 文档 | 内容 |
| --- | --- |
| [总览](docs/spec/00-overview.md) | spec 的范围、文档规划和通用约定：记号、标识、时间、语言标识、接口版本 |
| [架构](docs/spec/01-architecture.md) | 组件划分、连接与寻址、数据路径、部署视图、信任边界 |
| [数据模型](docs/spec/02-data-model.md) | 坐标与几何、画面、文字块、翻译单元、候选、竞速记录、变化图、译文缓存、显示事件 |
| [工作流定义](docs/spec/03-workflow.md) | 工作流文件格式、数据类型、节点目录、执行位置、校验规则、运行参数、默认模板 |
| [运行协调器](docs/spec/04-run-coordinator.md) | 状态机、批次调度、段落复用、译文缓存、竞速算法、请求调度、暂停与停止 |
| [变化检测](docs/spec/05-change-detection.md) | 截图的接受规则、待处理位、变化图的计算方法与实测开销 |
| [归一化](docs/spec/06-normalization.md) | 坐标换算、阅读顺序、行与段落合并、文字拼接 |
| [显示与排版](docs/spec/07-display.md) | 显示状态、本机覆盖层、网页观看端、截图浮卡、译文排版、显示设置 |
| [服务协议](docs/spec/08-service-protocol.md) | 传输与帧格式、握手与认证、多路复用的流、流量控制、时限、状态码、寻址与路由 |
| [服务接口](docs/spec/09-service-interfaces.md) | 每类服务的方法、调用形态、消息定义和行为规则 |
| [后台平台服务](docs/spec/10-backend.md) | 七个平台服务的数据、内存结构、数据库升级和关键行为 |
| [安全](docs/spec/11-security.md) | 威胁模型、主人认证、电脑配对与设备密钥、本机进程间通信、开放控制、数据保护 |
| [桌面端](docs/spec/12-desktop.md) | 进程划分、主程序、Windows 与 macOS 的系统集成实现、本机存储 |
| [网页端](docs/spec/13-web.md) | 页面、与后台的连接、观看、AI 对话、节点编辑器、管理功能 |
| [部署与运维](docs/spec/14-deployment.md) | 后台组成、首次部署、证书、透传中转、升级、备份与恢复、出站代理、桌面端发行 |
| [技术选型](docs/spec/15-tech-selection.md) | 许可规则、语言与框架、服务协议、后台组件、OCR 与翻译引擎、模型、许可义务 |
| [验收与测试](docs/spec/16-acceptance.md) | 验收样本、测试替身、指标定义、竞速与平台的测试方法 |
| [AI 助手](docs/spec/17-assistant.md) | 会话、心跳、门控、AI 大脑、平台工具、屏幕标注、AI 卡片 |
| [第一版实现](docs/spec/18-v1-implementation.md) | 第一版的技术选型、进程、协议承载、代码结构、各模块的函数 |

## 开发原则

平台尽可能复用现成开源项目，复用单位包括独立的库、可提取的模块和具体代码，不要求整体照搬某个完整软件。

平台的各项能力拆成独立的服务，以尽可能提高兼容性。每个工作流节点由一个服务执行，同一类能力的不同引擎各是一个服务，同一类服务使用同一套接口。与操作系统无关的服务可以打包成容器，也可以作为本机进程运行；依赖桌面接口的部分在 Windows 和 macOS 上各有一份原生实现。拆分规则见 [服务拆分](docs/requirements/06-services.md)。

平台从第一版起预留多语言支持。界面语言、OCR 识别语言和翻译语言分别配置，新增语言不需要改动处理流程。

## 许可

本项目采用 GNU Affero 通用公共许可证第 3 版（GNU Affero General Public License v3.0，AGPL-3.0）与商业许可双授权。

按 AGPL-3.0 使用时，修改后的版本以网络服务形式提供给他人，也必须向这些用户公开对应的完整源代码。为方便履行这项义务，网页端页脚提供源代码链接，修改代码后再部署的人需要把它换成自己的版本。许可证全文见 [LICENSE](LICENSE)。

不希望承担 AGPL-3.0 义务的商业使用，需要向仓库所有者另行取得商业许可。

接受外部贡献之前，贡献者需要签署贡献者许可协议（Contributor License Agreement，CLA），授权仓库所有者把贡献的代码同时以 AGPL-3.0 和商业许可授出。只签开发者原创证明（Developer Certificate of Origin，DCO）不够：DCO 只声明贡献者有权按项目的开源许可提交代码，不授予以商业许可再授权的权利。
