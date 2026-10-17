# 后台平台服务

对应需求：[产品需求](../requirements/01-product.md) 第 2.2、2.4、8 节，[账号、设备与共享](../requirements/05-accounts-devices-sharing.md)，[服务拆分](../requirements/06-services.md) 第 3.3、5 节。

本文规定后台七个平台服务各自的内部结构：保存哪些数据、数据怎样组织、关键行为怎样实现。它们对外的方法见 [服务接口](09-service-interfaces.md)，部署方式见 14 部署与运维。

## 1 总体约定

### 1.1 进程与数据

每个平台服务是一个独立的容器，由同一个 Rust 代码库构建出不同的可执行文件。需要持久保存数据的服务，各自在自己的数据卷中有一个 SQLite 数据库文件，其他服务只能通过接口读写它（[架构](01-architecture.md) 3.2）：

| 服务 | 数据库 | 其他持久数据 |
| --- | --- | --- |
| 账号与认证 | `auth.db` | 无 |
| 服务注册 | `registry.db`，只存用量统计 | 无 |
| 工作流与配置存储 | `config.db` | 无 |
| 历史记录存储 | `history.db` | 截图等二进制文件，存放在数据卷的 `blobs/` 目录中 |
| 设备连接与中转、观看分发、网页前端 | 无 | 无，状态只在内存中 |

数据库使用预写日志模式（WAL）。WAL 要求访问数据库的进程在同一台主机上，文件不能放在网络文件系统中；编排文件把数据卷放在本地磁盘上（14 部署与运维）。

### 1.2 时间与标识

数据库中的时刻统一存为 RFC 3339 的 UTC 字符串，标识存为小写的 UUID 字符串（[总览](00-overview.md) 3.3、3.4）。UUID 第 7 版按字典序就是按时间排序，列表分页直接以标识为游标：取"标识小于上一页最后一条"的若干条。

### 1.3 数据库结构的升级

每个数据库用 SQLite 的 `user_version` 记录结构版本。服务启动时，在开始接受连接之前：

1. 读取 `user_version`，与本版本程序要求的结构版本比较。高于要求时，说明数据库来自更新的版本，例如升级失败、程序换回旧版本之后，服务以错误退出，不读写数据库，并在日志中写明两个版本号；恢复由 `sth-admin` 负责（[部署与运维](14-deployment.md) 6.1）；
2. 需要升级时，先用 `VACUUM INTO` 把数据库完整复制一份到 `backups/` 目录，文件名包含服务名、时刻和原结构版本；
3. 在一个事务中依次执行各步升级，最后更新 `user_version`；
4. 任何一步失败，事务回滚，数据库保持升级前的样子，服务以错误退出，并在日志中写明失败的步骤。

SQLite 的建表和改表语句都在事务之内，第 4 步的回滚因此是完整的。部署者此时把容器镜像换回旧版本，就恢复到升级前的状态，这满足需求 01 第 2.4 节"迁移失败时用备份回滚"。第 2 步的备份另外防范升级程序本身的逻辑错误：升级成功但数据被改错时，可以用这份备份恢复。

`VACUUM INTO` 发生在服务开始接受连接之前，此时没有其他连接写入，复制得到的就是一致的快照。

## 2 设备连接与中转

设备连接与中转实现 [服务协议](08-service-protocol.md) 第 3 节的握手和第 8.2 节的路由。它在内存中维护三张表：

| 表 | 键 | 内容 |
| --- | --- | --- |
| 连接表 | 连接标识 | 对端的身份类型、身份、协议版本、打开的流数 |
| 路由表 | 设备标识，或者后台服务的名称 | 对应的连接 |
| 流映射表 | （连接，流标识） | 另一端的（连接，流标识） |

规则：

- 握手时，设备签名和浏览器会话交给账号与认证验证（`VerifyDevice`、`VerifySession`）；后台服务的凭据由中转自己核对，它在启动时从编排文件的机密配置读取各服务凭据的哈希；
- 同一台电脑同时只保留一条连接。新连接通过认证后，旧连接收到 `GoAway` 并被关闭；
- 电脑上线和离线时，中转通知服务注册，服务注册再通过 `Watch` 通知运行协调器（[运行协调器](04-run-coordinator.md) 6.3）；
- 中转订阅 `auth.WatchRevocations`（[服务接口](09-service-interfaces.md) 第 18 节）：收到被撤销的电脑，立即关闭它的连接；收到失效的会话，立即关闭这个会话的全部浏览器连接。浏览器连接在连接表中记有会话标识，中转据此找到要关闭的连接（[安全](11-security.md) 2.6、3.4）；
- 每条连接同时打开的流不超过 128 条，超过时新的 `Open` 以 `rate_limited` 关闭，附带 1 秒的重试等待时间，说明为"连接上的流已满"。流已满只是暂时的状态，运行协调器按限流处理，等待时间过后即恢复（[运行协调器](04-run-coordinator.md) 6.3）。

中转不解码业务消息，它的内存占用由流的数量和额度决定：最坏情况下每条连接 128 MiB（[服务协议](08-service-protocol.md) 第 5 节）。

## 3 账号与认证

### 3.1 数据

```sql
CREATE TABLE owner (
  id               INTEGER PRIMARY KEY CHECK (id = 1),   -- 一套部署只有一个主人
  username         TEXT NOT NULL,
  password_hash    TEXT NOT NULL,                        -- Argon2id，PHC 字符串格式
  totp_secret      BLOB,                                 -- 未开启二步验证时为空
  totp_last_step   INTEGER,                              -- 最近一次验证成功的时间步
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE recovery_codes (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL,                              -- Argon2id
  used_at    TEXT
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                        -- UUID 第 7 版
  token_hash    BLOB NOT NULL UNIQUE,                    -- 会话令牌的 SHA-256
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  user_agent    TEXT,
  address       TEXT,
  known_browser_id TEXT,                                 -- 签发这个会话的浏览器，见 known_browsers
  revoked_at    TEXT
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  public_key    BLOB NOT NULL,                           -- ECDSA P-256，SubjectPublicKeyInfo 的 DER 编码
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT
);

CREATE TABLE pairing_codes (
  code_hash   BLOB PRIMARY KEY,                          -- 配对码的 SHA-256
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  revoked_at  TEXT                                       -- 失败次数达到上限时一并作废
);

CREATE TABLE pairing_failures (
  id        INTEGER PRIMARY KEY CHECK (id = 1),          -- 所有有效配对码共用一个计数
  count     INTEGER NOT NULL
);

CREATE TABLE login_failures (
  key      TEXT PRIMARY KEY,                             -- 'account' 或 'addr:' 加来源地址
  count    INTEGER NOT NULL,
  last_at  TEXT NOT NULL
);

CREATE TABLE known_browsers (
  id            TEXT PRIMARY KEY,                        -- 登录成功时写入浏览器的标识
  token_hash    BLOB NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  revoked_at    TEXT                                     -- 作废后，带这个标记的登录按陌生浏览器计数
);
```

### 3.2 行为

- 首次启动时没有主人账号。部署说明要求部署者用命令行创建主人账号，网页端在此之前只显示"请先在服务器上创建账号"的说明。这样做，公网上的第一个访问者就无法抢先注册成为主人；
- 登录按 [安全](11-security.md) 2.1 至 2.3 校验密码和二步验证，按 2.2 的规则限速；登录成功时，为这个浏览器写入一行 `known_browsers`，并设置对应的 Cookie，新会话的 `known_browser_id` 记下这一行；
- 配对码按 [安全](11-security.md) 3.1 生成和校验。猜错一次，`pairing_failures` 加一；累计达到 5 次时，把全部有效的配对码标为作废，计数清零，主人需要重新生成。配对成功时写入 `devices`，把这个配对码标为已用；
- 会话的空闲超时和绝对有效期到期后，`VerifySession` 不再通过，账号与认证同时经 `WatchRevocations` 推送这个会话，中转关闭它的连接；过期和已撤销的会话行每天清理一次；
- 注销会话时，在同一个事务中把会话标为已撤销，并作废它的 `known_browser_id` 指向的已知浏览器标记。修改密码时，除当前会话外的全部会话标为已撤销，除当前浏览器外的全部已知浏览器标记作废。两种情况都经 `WatchRevocations` 推送（需求 05 第 5 节）；
- 命令行重置分两条命令（需求 05 第 2 节，[部署与运维](14-deployment.md) 第 3 节）。重置密码时，只更新 `owner` 的密码，二步验证和恢复码保持不变：忘记密码与验证器无关，删掉恢复码反而让主人之后丢失验证器时无码可用。重置二步验证时，清空 `totp_secret` 和 `totp_last_step`，删除全部 `recovery_codes`。两条命令都在同一个事务中把全部会话标为已撤销、作废全部已知浏览器标记，并推送撤销。

## 4 服务注册

服务注册在内存中保存当前登记的全部服务，登记随连接存在，连接断开即注销（[服务协议](08-service-protocol.md) 第 12 节）。它不把登记信息写入磁盘：后台重启后，各服务和电脑重新连接、重新登记，内存中的表随之重建。

`registry.db` 只保存用量统计，供网页端按服务显示调用次数和用量（需求 04 第 10 节）：

```sql
CREATE TABLE usage (
  device       TEXT NOT NULL,
  service      TEXT NOT NULL,
  target_host  TEXT NOT NULL DEFAULT '',                 -- 自定义 HTTP 请求按目标主机分别计量，其他服务为空
  period       TEXT NOT NULL,                            -- 计费周期，协调世界时的自然月，例如 2026-10
  calls        INTEGER NOT NULL,
  units        INTEGER NOT NULL,                         -- 按服务的计量方式：调用次数、字符或词元
  PRIMARY KEY (device, service, target_host, period)
);
```

执行计量的服务每次调用结束后经 `ReportUsage` 报告用量，服务注册累加到这张表；网页端和重启后的计量服务经 `GetUsage` 读取（[服务接口](09-service-interfaces.md) 第 14、17 节）。

费用上限保存在工作流与配置存储（第 7 节），执行计量的服务经 `config.WatchServiceSettings` 订阅后自己执行。服务注册同样订阅这些设置，在上限变化时经 `Watch` 发出"费用上限变化"，运行协调器据此恢复因 `quota_exceeded` 不可用的服务。

服务注册还订阅 `auth.WatchRevocations`：某台电脑被撤销时，删除它登记的全部服务，经 `Watch` 发出"设备已撤销"（[服务接口](09-service-interfaces.md) 第 17、18 节）。

## 5 观看分发

观看分发的全部状态都在内存中，不写入磁盘（需求 05 第 7 节）。

### 5.1 来源

每一路来源对应一条 `Publish` 流。流开始时，运行协调器先发来当前的显示快照和批次画面，之后才是事件（[服务接口](09-service-interfaces.md) 第 19 节），观看分发因此总是从完整的状态开始。它为每一路来源保存：

| 内容 | 说明 |
| --- | --- |
| 显示状态 | 把这一路的显示事件依次作用在空状态上得到，内容与显示快照相同（[数据模型](02-data-model.md) 10.4） |
| 当前批次画面 | 运行协调器以有损压缩发来的原始分辨率画面 |
| 上一张批次画面 | 新批次的 `batch_start` 发出后，订阅者可能还在请求旧画面，保留到下一次切换 |
| 缩放缓存 | 按（画面，宽度，是否省流）缓存编码好的结果 |
| 订阅者 | 每个订阅者的流和它当前的发送额度 |

缩放缓存的总大小有上限，满了以后淘汰最久没有被请求的一项；上限的默认值待定。画面被新批次替换两次以后，它的缩放结果也随之删除。

### 5.2 屏幕共享开关

主程序通过 `SetSharing` 报告电脑的共享开关。开关关闭时，以及经 `auth.WatchRevocations` 得知这台电脑被撤销时，观看分发立即：

1. 把这台电脑的全部来源从来源列表中删除；
2. 向这些来源的订阅者发送运行已下线的状态，并结束订阅流；
3. 丢弃这些来源的显示状态、画面和缩放缓存。

运行协调器同时停止发送（[服务接口](09-service-interfaces.md) 第 3 节）。两边各自执行这条规则：运行协调器一侧保证画面不离开电脑，观看分发一侧保证开关关闭后后台不再保留任何画面，即使运行协调器晚了一步才停止发送。

### 5.3 慢速观看端

订阅者的发送额度耗尽时，观看分发不为它排队积压事件，只记下"这个订阅者落后了"。额度恢复后，先发送一份当前的快照，再继续发送此后的事件。手机网络变差时，观看端因此直接跳到最新的画面和译文，中间积压的变化一律跳过（[服务接口](09-service-interfaces.md) 第 19 节）。

### 5.4 网页对话面板

`PublishDialog` 收到的 `DialogMessage`，转发给当前所有 `SubscribeDialogs` 订阅者；消息带有运行、节点和轮次，网页端据此把回答归到各自的对话中（[服务接口](09-service-interfaces.md) 第 19 节）。观看分发不保存对话内容：对话的历史由发起运行的电脑在运行结束时保存到历史记录（[运行协调器](04-run-coordinator.md) 11.4），网页端需要时从历史记录中读取。

## 6 网页前端

网页前端服务提供网页端构建后的静态文件，并为每个响应设置安全相关的响应头（[安全](11-security.md) 第 8 节）：

- `Content-Security-Policy`：脚本、样式和连接只允许来自本站，禁止内联脚本，`frame-ancestors 'none'`；
- `Referrer-Policy: no-referrer`；
- `X-Content-Type-Options: nosniff`。

页脚的源代码链接指向这个部署运行的版本对应的仓库地址（需求 01 第 3 节）。链接地址在构建时写入，部署者修改代码后需要改成自己的仓库，部署说明会提醒这一点。

## 7 工作流与配置存储

### 7.1 数据

```sql
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  entry       TEXT NOT NULL,
  doc         TEXT NOT NULL,                             -- 工作流文档的 JSON
  valid       INTEGER NOT NULL,                          -- 静态校验是否通过
  updated_at  TEXT NOT NULL
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                             -- JSON
  updated_at  TEXT NOT NULL
);

CREATE TABLE service_settings (
  service     TEXT PRIMARY KEY,                          -- 后台服务的登记名称
  settings    TEXT NOT NULL,                             -- ServiceSettings 的 JSON：调低的上限、费用上限、代理
  updated_at  TEXT NOT NULL
);

CREATE TABLE external_services (
  name        TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                             -- ai 或 credential
  config      TEXT NOT NULL,                             -- AI 服务的地址、模型、能力、计量方式，JSON，不含凭据
  secret      BLOB,                                      -- 凭据的内容
  updated_at  TEXT NOT NULL
);
```

### 7.2 行为

保存工作流时，在同一个事务中：读出当前的修订号，与提交的修订号比较；相等则写入新内容，修订号加一；不相等则不写入，回复冲突（[工作流定义](03-workflow.md) 第 1 节）。SQLite 同一时刻只允许一个写事务，读出和写入在同一个事务里，两个编辑器同时保存时，后提交的一方一定看到前一方写入后的修订号。

平台设置包括后台历史记录的容量上限、全局出站代理（需求 01 第 2.5 节）、会话的空闲超时和绝对有效期。

`service_settings` 只保存后台服务的设置，电脑上的服务的设置保存在那台电脑上（[服务接口](09-service-interfaces.md) 第 20 节）。设置变化时，订阅了 `WatchServiceSettings` 的服务注册和相应的后台服务立即收到。

`external_services` 保存网页端配置的后台 AI 服务和命名凭据（需求 01 第 6 节）。凭据的内容只经 `WatchExternalServices` 交给 AI 适配服务和自定义 HTTP 请求服务，`ListExternalServices` 和网页端都不返回它（[安全](11-security.md) 7.2）。这两个服务没有自己的持久数据，每次启动时从这里读取配置，再订阅变化。

## 8 历史记录存储

### 8.1 数据

```sql
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,                          -- UUID 第 7 版，由主程序或网页端生成
  kind        TEXT NOT NULL,                             -- screenshot、selection、conversation、node_output
  created_at  TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  run_id      TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  size_bytes  INTEGER NOT NULL,                          -- 元数据与全部文件的大小之和
  meta        TEXT NOT NULL                              -- JSON：段落、译文、对话消息等文字内容
);
CREATE INDEX entries_kind_id ON entries (kind, id);

CREATE TABLE blobs (
  entry_id    TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                             -- 例如 screenshot.png、message-3-image-1.webp
  size_bytes  INTEGER NOT NULL,
  PRIMARY KEY (entry_id, name)
);

CREATE TABLE pending_changes (
  entry_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,                             -- 需要通知的电脑
  change      TEXT NOT NULL,                             -- deleted、pinned 或 unpinned
  changed_at  TEXT NOT NULL,
  PRIMARY KEY (entry_id, device_id)                      -- 同一条目只保留最后一次变化
);
```

图片等二进制内容存为数据卷中的文件，路径为 `blobs/` 加条目标识的前两个字符、条目标识、文件名。文件不放进数据库：截图动辄数 MB，放在数据库外，备份和清理都可以直接按文件处理，数据库本身保持小巧。

### 8.2 写入与容量

`Upload` 写入一个条目的步骤：

1. 先把文件写到临时文件名，全部写完后再改名为正式文件名；
2. 在一个事务中写入 `entries` 和 `blobs`。条目标识已经存在时：设备标识为后台的对话条目，即网页端上传的对话，用新内容覆盖原来的条目，网页端每轮回答完成后用同一个标识上传一次；其他条目跳过。上传因此可以安全地重复进行；
3. 执行容量检查：总大小超过上限时，按标识从小到大（即从旧到新）删除未标记保留的条目，直到总大小不超过上限（需求 01 第 8 节）。容量清理只删除后台的副本，不写通知：两端的容量上限各自设置。

只剩标记为保留的条目、总大小仍超过上限时，不再删除，网页端提示用户取消一些保留标记或调高上限。

第 1 步先写文件、第 2 步再写数据库，崩溃时最多留下没有数据库记录的孤立文件，不会出现数据库指向不存在的文件。服务每天扫描一次，删除超过一天的孤立文件。

在线备份恢复之后是例外：数据库备份完成后、文件复制到达之前被删除的条目，备份中还有记录，文件却不在了（[部署与运维](14-deployment.md) 第 7 节）。所以服务每次启动时，删除文件缺失的条目，在日志中记下数量。这些条目在备份进行时已经被用户或清理删除，删掉它们与用户的操作一致。

### 8.3 删除与保留标记的同步

用户在网页端删除一条记录，或者按时间、种类手动清理时，在同一个事务中删除 `entries` 的行；手动清理跳过标记为保留的记录。被删除的记录来自某台电脑时，再为这台电脑写入一行 `pending_changes`，变化为 `deleted`。事务提交后删除文件。

用户在网页端标记或取消保留时，同样为来源电脑写入一行 `pending_changes`，变化为 `pinned` 或 `unpinned`。

后台产生的记录，即网页对话面板中直接发起的对话，没有本机副本，不写通知。来源电脑在线时，经 `WatchChanges` 立即收到通知；不在线时，下次连接时收到。电脑确认处理了本机副本后，对应的 `pending_changes` 行被删除。

反方向的同步由主程序发起：用户在桌面端删除、手动清理或改变保留标记时，主程序对已经上传的记录调用 `Delete`、`SetPinned`，后台照常处理，但不再给发起的电脑写通知（需求 01 第 8 节，[服务接口](09-service-interfaces.md) 第 21 节）。

## 9 日志

各服务的日志按 [安全](11-security.md) 7.4 只记录标识、状态、耗时和失败原因，不记录画面、文字、译文、对话和凭据。日志写到标准输出，由容器运行时收集，便于部署者用自己熟悉的工具查看。
