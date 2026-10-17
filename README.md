# screen-translate-hub

screen-translate-hub 是一个自部署的屏幕翻译与 AI 平台。Windows 与 macOS 桌面端负责截图、划词、持续屏幕采集和本机显示，Docker 后台负责账号、设备连接、跨设备中转和服务器侧处理，手机与电脑浏览器负责观看经过翻译或 AI 加工的画面，以及与 AI 对话。

平台的主线场景是持续屏幕翻译：用户在电脑上选定窗口或区域，平台持续识别画面文字，并把译文叠加在原文位置，同时在本机和网页上展示。截图翻译、划词翻译、划词问 AI 和图片问 AI 共用同一套处理能力。

## 当前阶段

项目处于规格说明（specification，下文简称 spec）阶段，仓库中只有文档，没有代码。需求文档已经确定，spec 的各份文档已经写出初稿，原型阶段要实测确认的技术事项列在 [技术选型](docs/spec/15-tech-selection.md) 第 13 节；参数的默认值、验收指标的合格线和默认快捷键列在 [待定事项](docs/requirements/open-questions.md) 第 2、3 节。

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

## 开发原则

平台尽可能复用现成开源项目，复用单位包括独立的库、可提取的模块和具体代码，不要求整体照搬某个完整软件。

平台的各项能力拆成独立的服务，以尽可能提高兼容性。每个工作流节点由一个服务执行，同一类能力的不同引擎各是一个服务，同一类服务使用同一套接口。与操作系统无关的服务可以打包成容器，也可以作为本机进程运行；依赖桌面接口的部分在 Windows 和 macOS 上各有一份原生实现。拆分规则见 [服务拆分](docs/requirements/06-services.md)。

平台从第一版起预留多语言支持。界面语言、OCR 识别语言和翻译语言分别配置，新增语言不需要改动处理流程。

## 许可

本项目采用 GNU Affero 通用公共许可证第 3 版（GNU Affero General Public License v3.0，AGPL-3.0）与商业许可双授权。

按 AGPL-3.0 使用时，修改后的版本以网络服务形式提供给他人，也必须向这些用户公开对应的完整源代码。为方便履行这项义务，网页端页脚提供源代码链接，修改代码后再部署的人需要把它换成自己的版本。许可证全文见 [LICENSE](LICENSE)。

不希望承担 AGPL-3.0 义务的商业使用，需要向仓库所有者另行取得商业许可。

接受外部贡献之前，贡献者需要签署贡献者许可协议（Contributor License Agreement，CLA），授权仓库所有者把贡献的代码同时以 AGPL-3.0 和商业许可授出。只签开发者原创证明（Developer Certificate of Origin，DCO）不够：DCO 只声明贡献者有权按项目的开源许可提交代码，不授予以商业许可再授权的权利。
