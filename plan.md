# kaname-relay 实现计划

最后更新：2026-06-17

本文档是后续实现的唯一依据。实现过程中如果发现本文档与实际约束冲突，先更新本文档并经确认，再改代码。

## 1. 项目目标与非目标

### 1.1 目标

kaname-relay 是一个轻量 webhook relay：

1. 接收来自 Komari、Wallos 或通用 HTTP webhook 的事件。
2. 按 source、event type、payload 字段和规则条件进行匹配。
3. 用规则模板渲染通知内容。
4. 将一次入站事件拆成一个或多个 outbox 投递任务。
5. 通过 Telegram、Email、通用 webhook 等 notifier 做异步投递。
6. 提供 WebUI 管理 source、规则、渠道、测试发送、outbox、日志和重放。
7. 同一套核心逻辑同时支持：
   - 低配 Debian VPS / 树莓派：Docker Compose 或裸 Node.js + SQLite。
   - Cloudflare Workers：Hono Worker + D1 + Cron Trigger。

核心运行模型：

```txt
HTTP webhook
-> 认证 / 验签 / 解析
-> 入站去重
-> 规则匹配
-> 模板渲染
-> 写 outbox
-> 立即返回 202
-> 后台 processPending 异步投递
```

### 1.2 非目标

以下内容不进入 MVP，除非后续明确扩展：

1. 不做完整工作流编排器，例如条件分支 DAG、人工审批、复杂状态机。
2. 不做 exactly-once 投递承诺；外部通知平台无法可靠保证严格一次。
3. 不做强顺序投递承诺；只保证 due time、priority 的 best-effort 领取顺序。
4. 不做多租户 SaaS、组织、团队、RBAC、计费系统。
5. 不做重型队列依赖；MVP 不引入 Redis、Postgres、Cloudflare Queues。
6. 不做复杂监控平台；只保留必要日志、状态、失败原因和重放能力。
7. 不做插件热加载；模块化以 TypeScript 包和注册表为边界，重新构建后生效。
8. 不把 Worker 版当作 Node 版的字节级副本；两边共享核心编排，但运行时适配不同。
9. 不在请求链里等待 Telegram、Email 等外部网络发送完成。
10. 不在 WebUI 中暴露明文 secret；secret 只允许创建、替换、测试，不允许回显。

## 2. 技术栈与理由

| 部分 | 选择 | 理由 |
| --- | --- | --- |
| HTTP 框架 | Hono | 基于 Web Standards 的 Request/Response 模型，能同时适配 Node.js 和 Cloudflare Workers。 |
| WebUI | Vite + Vue 3 | 构建后是静态文件，运行时无前端服务进程；Vue 适合管理后台表单和状态 UI。 |
| VPS 数据库 | SQLite | 单文件、无独立数据库进程，适合 1C512M VPS 和树莓派。 |
| Worker 数据库 | Cloudflare D1 | D1 是 Cloudflare 托管的 SQLite 语义数据库，适合 Worker 版持久化。 |
| ORM / schema | Drizzle ORM | 类型安全、轻量，支持 SQLite 和 D1，schema 可尽量共享。 |
| 包管理 | pnpm workspace | monorepo 依赖去重好，适合 packages + apps 的拆分。 |
| Node SQLite driver | better-sqlite3 | 同步、轻量、稳定，适合低并发 webhook relay；Store 层对外仍暴露 Promise 接口。 |
| Worker 部署 | Wrangler | Cloudflare 官方 Workers/D1/Cron/migrations 部署工具。 |
| 通用 Email | Resend HTTP API | 两个运行时都能通过 fetch 调用；避免 Worker 上 SMTP/TCP 兼容问题。 |
| VPS-only Email | SMTP / Nodemailer | 作为 VPS 增强 transport，不作为跨运行时必备能力。 |

## 3. Monorepo 目录结构

```txt
.
├─ apps/
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ index.ts
│  │  │  ├─ http/
│  │  │  ├─ scheduler/
│  │  │  └─ static/
│  │  ├─ Dockerfile
│  │  └─ package.json
│  ├─ worker/
│  │  ├─ src/
│  │  │  ├─ index.ts
│  │  │  ├─ bindings.ts
│  │  │  └─ assets.ts
│  │  ├─ wrangler.toml
│  │  └─ package.json
│  └─ web/
│     ├─ src/
│     │  ├─ pages/
│     │  ├─ components/
│     │  ├─ stores/
│     │  └─ api/
│     ├─ vite.config.ts
│     └─ package.json
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ adapters/
│  │  │  ├─ engine/
│  │  │  ├─ process-pending.ts
│  │  │  ├─ template.ts
│  │  │  ├─ types.ts
│  │  │  └─ errors.ts
│  │  └─ package.json
│  ├─ store/
│  │  ├─ src/
│  │  │  ├─ schema.ts
│  │  │  ├─ migrations/
│  │  │  ├─ sqlite-store.ts
│  │  │  ├─ d1-store.ts
│  │  │  └─ types.ts
│  │  └─ package.json
│  └─ notifiers/
│     ├─ src/
│     │  ├─ telegram.ts
│     │  ├─ resend.ts
│     │  ├─ smtp.node.ts
│     │  ├─ webhook.ts
│     │  ├─ registry.ts
│     │  └─ types.ts
│     └─ package.json
├─ docs/
├─ docker-compose.yml
├─ package.json
├─ pnpm-workspace.yaml
└─ plan.md
```

### 3.1 包职责

`packages/core`

- 定义领域类型、SourceAdapter、Notifier、Store 接口。
- 负责 webhook 事件标准化、规则匹配、模板渲染、outbox 编排。
- 提供 `processPending()`，不直接依赖 Node.js、D1、Wrangler、Hono、Vue。
- 只使用 Web Standards、普通 TypeScript 和注入的依赖。

`packages/store`

- 定义 Drizzle schema 和 migration 输出。
- 实现 `SqliteStore`：VPS / 树莓派使用 better-sqlite3。
- 实现 `D1Store`：Worker 使用 Cloudflare D1 binding。
- 负责 SQL 差异隐藏在 Store 实现内，不能泄漏到 core。

`packages/notifiers`

- 实现 Telegram、Resend、通用 webhook notifier。
- 实现 `smtp.node.ts` 作为 Node-only 可选模块。
- 所有 notifier 使用统一 `Notifier` interface。
- Worker bundle 不得静态导入 Node-only notifier。

`apps/server`

- Node.js / Docker 入口。
- 创建 Hono app、SQLite store、notifier registry。
- serve WebUI 静态文件。
- 用 `setInterval` 驱动 `processPending()`。
- 提供 graceful shutdown。

`apps/worker`

- Cloudflare Worker 入口。
- 创建 Hono app、D1 store、notifier registry。
- 在 fetch handler 中写 outbox 后用 `ctx.waitUntil()` 做 bounded 首投。
- 在 scheduled handler 中用 Cron Trigger 做重试兜底。
- 不导入 Node-only 包。

`apps/web`

- Vite + Vue 3 管理后台。
- 只调用后端管理 API。
- 构建产物由 `apps/server` 或 Worker assets 托管。

### 3.2 依赖方向

允许：

```txt
apps/server  -> packages/core, packages/store, packages/notifiers
apps/worker  -> packages/core, packages/store, packages/notifiers
apps/web     -> backend HTTP API only
packages/store -> packages/core types only
packages/notifiers -> packages/core types only
```

禁止：

```txt
packages/core -> apps/*
packages/core -> packages/store implementation
packages/core -> Node.js-only APIs
packages/core -> Cloudflare-only APIs
packages/notifiers generic entry -> smtp.node.ts static import
apps/web -> database direct access
```

## 4. 核心数据模型

所有时间字段使用 Unix epoch milliseconds，类型为 `INTEGER`。所有布尔字段使用 `INTEGER`，取值 `0` 或 `1`。JSON 使用 `TEXT` 存储 UTF-8 JSON 字符串。主键使用 `TEXT`，建议 ULID，因为按时间大致有序且适合日志查看。

实际 migration 建表顺序必须满足外键依赖：

```txt
webhook_sources
-> channels
-> rules
-> rule_channels
-> received_events
-> outbox
-> sent_log
-> app_settings
```

### 4.1 `webhook_sources`

配置入站 webhook source。

```sql
CREATE TABLE webhook_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_json_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_sources_type_enabled
  ON webhook_sources (type, enabled);
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `TEXT` | source id，URL 中使用。 |
| `name` | `TEXT` | WebUI 显示名。 |
| `type` | `TEXT` | `generic`、`komari`、`wallos` 等 adapter 类型。 |
| `enabled` | `INTEGER` | 禁用后拒绝或忽略新入站事件。 |
| `config_json` | `TEXT` | 非敏感配置，例如字段映射、事件类型字段。 |
| `secret_json_enc` | `TEXT` | 加密后的 secret，例如签名密钥、token。 |
| `created_at` | `INTEGER` | 创建时间。 |
| `updated_at` | `INTEGER` | 更新时间。 |

### 4.2 `rules`

规则负责把标准化后的入站事件映射为一个或多个通知任务。

```sql
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 0,
  match_json TEXT NOT NULL DEFAULT '{}',
  template_json TEXT NOT NULL DEFAULT '{}',
  stop_on_match INTEGER NOT NULL DEFAULT 0 CHECK (stop_on_match IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES webhook_sources(id) ON DELETE CASCADE
);

CREATE INDEX idx_rules_source_enabled_priority
  ON rules (source_id, enabled, priority DESC);

CREATE INDEX idx_rules_enabled_priority
  ON rules (enabled, priority DESC);
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source_id` | `TEXT NULL` | 指定 source；为 `NULL` 时表示全局规则。 |
| `priority` | `INTEGER` | 数字越大越先匹配。 |
| `match_json` | `TEXT` | 规则条件，MVP 使用受限 JSON 条件 DSL。 |
| `template_json` | `TEXT` | 标题、正文、HTML/Markdown 等模板。 |
| `stop_on_match` | `INTEGER` | 命中后是否停止继续匹配低优先级规则。 |

MVP 规则 DSL 不执行用户 JavaScript。建议支持：

```json
{
  "all": [
    { "path": "$.eventType", "op": "eq", "value": "down" },
    { "path": "$.payload.severity", "op": "in", "value": ["warn", "critical"] }
  ]
}
```

MVP 支持的 `op`：

```txt
eq, ne, contains, in, exists
```

`regex`、`starts_with`、`ends_with` 暂不进入 MVP。`regex` 只有在引入安全 regex 引擎，或实现硬性长度限制与执行超时后才能开启；Worker 免费版的单次 CPU 上限无法承受灾难性回溯。

### 4.3 `rule_channels`

规则和通知渠道是多对多关系。一个入站事件命中一条规则后，对每个启用的关联渠道创建一个 outbox 任务。

```sql
CREATE TABLE rule_channels (
  rule_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  template_override_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, channel_id),
  FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX idx_rule_channels_channel_enabled
  ON rule_channels (channel_id, enabled);
```

### 4.4 `channels`

通知渠道配置表。

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_json_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_channels_type_enabled
  ON channels (type, enabled);
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `TEXT` | `telegram`、`resend`、`smtp`、`webhook`、`discord` 等。 |
| `config_json` | `TEXT` | 非敏感配置，例如 chat id、from、to、URL、format。 |
| `secret_json_enc` | `TEXT` | 加密后的 token、API key、SMTP password。 |

secret 加密要求：

1. 使用 `APP_SECRET` 派生 AES-GCM key。
2. Node 和 Worker 都使用 Web Crypto 兼容实现。
3. WebUI API 不返回明文 secret，只返回 `hasSecret: true`、更新时间和掩码信息。
4. 如果 `APP_SECRET` 丢失，已保存的 secret 不可恢复；必须重新配置。

### 4.5 `received_events`

入站事件去重和观察表。

```sql
CREATE TABLE received_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  inbound_dedupe_key TEXT,
  event_type TEXT,
  payload_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  last_outbox_count INTEGER NOT NULL DEFAULT 0,
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  FOREIGN KEY (source_id) REFERENCES webhook_sources(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_received_events_source_dedupe
  ON received_events (source_id, inbound_dedupe_key);

CREATE INDEX idx_received_events_seen
  ON received_events (source_id, last_seen_at DESC);

CREATE INDEX idx_received_events_payload_hash
  ON received_events (source_id, payload_hash);
```

说明：

1. 如果 source adapter 能提供稳定 `inbound_dedupe_key`，使用唯一索引协调同一 source 下的入站去重。
2. 只有 `committed = 1` 的记录才算已经完整处理的重复事件。
3. `committed = 0` 表示上次 ingest 在中途崩溃或未完成；下一次相同 key 入站必须允许重新处理并覆盖对应 outbox，不能误判为重复。
4. 如果不能提供稳定 key，退化为只记录 `payload_hash`，不做强去重。
5. 是否启用基于 `payload_hash + time_bucket` 的近似去重，留作未决问题。

### 4.5.1 入站原子 ingest

HTTP handler 不允许分别调用 `recordReceivedEvent()` 和 `enqueueOutbox()`。入站持久化必须通过单个 Store 方法：

```txt
ingest(receivedEvent, outboxItems[])
```

`outboxItems[]` 可以为空；无规则命中时也必须把 `received_events.committed` 置为 `1`，表示该入站事件已完整处理，只是没有产生投递任务。

去重语义：

1. 相同 `(source_id, inbound_dedupe_key)` 且 `committed = 1`：视为重复入站，更新 `last_seen_at`、`seen_count`，不创建 outbox。
2. 相同 `(source_id, inbound_dedupe_key)` 且 `committed = 0`：视为上次崩在中途，允许重新处理；删除或覆盖该 received_event 关联的旧 outbox 后重新写入本次 outbox，再置 `committed = 1`。
3. 没有 `inbound_dedupe_key`：每次创建新的 received_event，不做强去重。

SQLite 实现：

1. 使用 `db.transaction()` 包住完整 ingest。
2. 先占位写入 `received_events`：

```sql
INSERT INTO received_events (
  id, source_id, inbound_dedupe_key, event_type, payload_hash,
  first_seen_at, last_seen_at, seen_count, last_outbox_count, committed
) VALUES (
  :id, :source_id, :inbound_dedupe_key, :event_type, :payload_hash,
  :now, :now, 1, 0, 0
)
ON CONFLICT(source_id, inbound_dedupe_key) DO UPDATE SET
  last_seen_at = excluded.last_seen_at,
  seen_count = received_events.seen_count + 1
RETURNING id, seen_count, committed;
```

3. 如果返回 `committed = 1` 且不是本次新建记录，直接返回 duplicate。
4. 如果返回 `committed = 0`，清理该 `received_event_id` 下未完成 outbox，写入新的 outbox rows。
5. 写完 outbox 后执行：

```sql
UPDATE received_events
SET committed = 1,
    last_outbox_count = :outbox_count,
    last_seen_at = :now
WHERE id = :received_event_id;
```

6. better-sqlite3 是同步 API；Store 对外仍返回 Promise，把事务结果包成 resolved Promise。

D1 实现：

1. D1 `batch()` 不能在同一 batch 中跨语句做复杂条件分支，因此采用两阶段。
2. 第一阶段执行 `INSERT ... ON CONFLICT ... RETURNING id, seen_count, committed` 占位。
3. 如果返回 `committed = 1`，更新 seen 信息后返回 duplicate，不写 outbox。
4. 如果返回 `committed = 0`，组第二个 `batch()`：清理旧 outbox、写新 outbox、`UPDATE received_events SET committed = 1`。
5. 两个运行时都以 `committed` 标志位作为统一心智；崩在中途时 `committed` 仍为 `0`，下一次相同 key 会干净重放，不会丢事件。

### 4.6 `outbox`

可靠投递核心表。一次 outbox row 表示一次向一个 channel 的投递任务。

```sql
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  received_event_id TEXT,
  rule_id TEXT,
  channel_id TEXT NOT NULL,
  notifier_type TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'dead', 'cancelled')),

  priority INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  locked_until INTEGER,
  lease_id TEXT,

  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,

  inbound_dedupe_key TEXT,
  outbound_dedupe_key TEXT,
  provider_idempotency_key TEXT,

  event_type TEXT,
  payload_json TEXT NOT NULL,
  message_json TEXT NOT NULL,

  last_error TEXT,
  last_error_at INTEGER,
  provider_message_id TEXT,
  provider_response_json TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  dead_at INTEGER,
  cancelled_at INTEGER,

  FOREIGN KEY (source_id) REFERENCES webhook_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (received_event_id) REFERENCES received_events(id) ON DELETE SET NULL,
  FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE SET NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_outbox_outbound_dedupe
  ON outbox (outbound_dedupe_key)
  WHERE outbound_dedupe_key IS NOT NULL;

CREATE INDEX idx_outbox_due
  ON outbox (status, next_at, priority DESC, created_at);

CREATE INDEX idx_outbox_lease_expired
  ON outbox (status, locked_until);

CREATE INDEX idx_outbox_channel_status
  ON outbox (channel_id, status, created_at DESC);

CREATE INDEX idx_outbox_source_created
  ON outbox (source_id, created_at DESC);
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `TEXT` | `pending` 可领取，`sending` 已租约领取，`sent` 成功，`dead` 终止失败，`cancelled` 手动或配置导致取消。 |
| `next_at` | `INTEGER` | 下一次可尝试发送的时间。 |
| `locked_until` | `INTEGER NULL` | 租约过期时间；崩溃回收依据。 |
| `lease_id` | `TEXT NULL` | 本轮领取批次 id，防止非持有者完成任务。 |
| `attempts` | `INTEGER` | 已失败尝试次数；成功不再增加。 |
| `max_attempts` | `INTEGER` | 单任务最大失败次数，默认 10。 |
| `inbound_dedupe_key` | `TEXT NULL` | source 侧事件去重 key。 |
| `outbound_dedupe_key` | `TEXT NULL` | 出站投递去重 key，建议包含 source、inbound key、rule、channel。 |
| `provider_idempotency_key` | `TEXT NULL` | 传给支持幂等的 provider，例如 Resend。 |
| `payload_json` | `TEXT` | 标准化事件快照。 |
| `message_json` | `TEXT` | 渲染后的消息快照；规则变更不影响已入队任务。 |
| `last_error` | `TEXT NULL` | 最近一次失败摘要，需截断长度。 |

`outbound_dedupe_key` 生成规则：

```txt
if inbound_dedupe_key exists:
  source_id + ":" + inbound_dedupe_key + ":" + rule_id + ":" + channel_id
else:
  null
```

没有稳定入站 key 时，不强行构造永久去重 key，避免误吞真实重复事件。

### 4.7 `sent_log`

成功投递日志，同时作为出站去重辅助表。

```sql
CREATE TABLE sent_log (
  id TEXT PRIMARY KEY,
  outbox_id TEXT,
  outbound_dedupe_key TEXT,
  channel_id TEXT NOT NULL,
  notifier_type TEXT NOT NULL,
  provider_message_id TEXT,
  provider_response_json TEXT,
  sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE SET NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_sent_log_outbox
  ON sent_log (outbox_id)
  WHERE outbox_id IS NOT NULL;

CREATE UNIQUE INDEX idx_sent_log_outbound_dedupe
  ON sent_log (outbound_dedupe_key)
  WHERE outbound_dedupe_key IS NOT NULL;

CREATE INDEX idx_sent_log_channel_sent
  ON sent_log (channel_id, sent_at DESC);
```

成功处理顺序必须是：

```txt
provider send success
-> insert sent_log
-> mark outbox sent
```

如果 `insert sent_log` 因唯一冲突失败，说明已有同一出站去重 key 的成功记录，本 outbox 直接标记为 `sent`，不再外发。

`Store.insertSentLog()` 不应把唯一冲突抛给 `processPending()` 当作发送失败；它必须返回已有 sent_log 或返回 `inserted: false` 的结果，让调用方直接 mark sent。

### 4.8 `app_settings`

少量全局配置。

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

可存：

```txt
admin password hash version
retention days
default backoff config
ui preferences
schema/app version marker
```

## 5. 可靠投递设计

### 5.1 语义承诺

系统承诺：

1. 入站请求只要通过认证、解析和规则处理，outbox 写入成功后即返回 `202 Accepted`。
2. 已写入 outbox 的任务会被后台反复尝试，直到 `sent`、`dead` 或 `cancelled`。
3. 任务领取使用 lease；进程或 Worker 崩溃后，过期 lease 会被回收。
4. 投递语义是 at-least-once。
5. 对支持 provider 幂等的渠道使用幂等 key 降低重复概率。

系统不承诺：

1. 不承诺 exactly-once。
2. 不承诺多个 channel 之间的顺序。
3. 不承诺同一 channel 下所有事件严格顺序。
4. 不承诺 `next_at` 到点后立即发送；Worker 版受 Cron 粒度和平台调度影响。

### 5.2 `processPending()` 定位

`processPending()` 是运行时无关的投递编排函数。它不是严格数学意义的纯函数，因为会读写 Store 并调用 Notifier；但它不能依赖 Node、Cloudflare、setInterval、waitUntil、Cron 或 HTTP 框架。

职责：

1. 回收过期 lease。
2. 领取到期 outbox 任务。
3. 对每个任务检查 sent_log 去重。
4. 加载 channel 当前配置和 secret。
5. 调用对应 notifier 发送。
6. 成功后写 sent_log 并标记 sent。
7. 失败后按指数退避更新 next_at，或转入 dead。
8. 返回本轮处理统计。

不做：

1. 不从 HTTP request 中解析 webhook。
2. 不做规则匹配和模板渲染；这些在 enqueue 阶段完成。
3. 不管理调度器生命周期。
4. 不无限循环直到队列清空。

### 5.3 `processPending()` 伪代码

```ts
async function processPending(args: ProcessPendingArgs): Promise<ProcessPendingResult> {
  const now = args.now();
  const leaseId = args.idGenerator();
  const leaseUntil = now + args.leaseMs;

  await args.store.recoverExpiredLeases({
    now,
    limit: args.recoverLimit,
    backoffDelaysMsByAttempt: args.backoffDelaysMsByAttempt,
    maxBackoffDelayMs: args.backoff.maxDelayMs,
  });

  const items = await args.store.claimDueOutbox({
    now,
    leaseId,
    leaseUntil,
    limit: args.limit,
  });

  await runWithConcurrency(items, args.maxConcurrency, async (item) => {
    if (item.outboundDedupeKey) {
      const existing = await args.store.findSentLogByDedupeKey(item.outboundDedupeKey);
      if (existing) {
        await args.store.markOutboxSentByLease({
          id: item.id,
          leaseId,
          now: args.now(),
          providerMessageId: existing.providerMessageId,
          providerResponseJson: existing.providerResponseJson,
        });
        return;
      }
    }

    const channel = await args.store.getEnabledChannel(item.channelId);
    if (!channel) {
      await args.store.cancelOutboxByLease({
        id: item.id,
        leaseId,
        now: args.now(),
        reason: "channel disabled or deleted",
      });
      return;
    }

    const notifier = args.notifiers[channel.type];
    if (!notifier) {
      await args.store.failOutboxByLease({
        id: item.id,
        leaseId,
        now: args.now(),
        error: "notifier not registered: " + channel.type,
        retry: false,
      });
      return;
    }

    try {
      const result = await withTimeout(
        notifier.send(item.message, {
          channel,
          idempotencyKey: item.providerIdempotencyKey ?? item.outboundDedupeKey ?? item.id,
          now: args.now,
          signal: args.abortSignalFactory(args.sendTimeoutMs),
        }),
        args.sendTimeoutMs,
      );

      const sentLog = await args.store.insertSentLog({
        outboxId: item.id,
        outboundDedupeKey: item.outboundDedupeKey,
        channelId: item.channelId,
        notifierType: item.notifierType,
        providerMessageId: result.providerMessageId,
        providerResponseJson: result.providerResponseJson,
        sentAt: args.now(),
      });

      await args.store.markOutboxSentByLease({
        id: item.id,
        leaseId,
        now: args.now(),
        providerMessageId: sentLog.providerMessageId ?? result.providerMessageId,
        providerResponseJson: sentLog.providerResponseJson ?? result.providerResponseJson,
      });
    } catch (error) {
      const failure = classifyNotifierError(error);
      const attempts = item.attempts + 1;

      if (!failure.retryable || attempts >= item.maxAttempts) {
        await args.store.markOutboxDeadByLease({
          id: item.id,
          leaseId,
          now: args.now(),
          attempts,
          error: failure.message,
        });
        return;
      }

      await args.store.scheduleOutboxRetryByLease({
        id: item.id,
        leaseId,
        now: args.now(),
        attempts,
        nextAt: args.now() + computeBackoffMs(attempts, args.backoff),
        error: failure.message,
      });
    }
  });

  return stats;
}
```

### 5.4 Lease 回收与领取 SQL

Store 必须把回收和领取做成可独立测试的方法。

回收过期租约。过期 lease 说明任务在发送过程中崩溃、超时或 Worker 被中止，必须记为一次失败，不能无成本回到 `pending`。Store 必须在同一个 SQLite transaction 或 D1 batch 中执行下面两类更新。

第一条：达到最大失败次数的 poison message 直接进入 `dead`：

```sql
UPDATE outbox
SET
  status = 'dead',
  attempts = attempts + 1,
  locked_until = NULL,
  lease_id = NULL,
  updated_at = :now,
  dead_at = :now,
  last_error = 'repeatedly failed before completion (suspected poison message)',
  last_error_at = :now
WHERE id IN (
  SELECT id
  FROM outbox
  WHERE status = 'sending'
    AND locked_until IS NOT NULL
    AND locked_until < :now
    AND attempts + 1 >= max_attempts
  ORDER BY locked_until ASC
  LIMIT :limit
);
```

第二条：未达到上限的过期任务回到 `pending`，同时 `attempts + 1`，并按和 catch 路径一致的退避策略设置 `next_at`：

```sql
UPDATE outbox
SET
  status = 'pending',
  attempts = attempts + 1,
  next_at = :now + CASE
    WHEN attempts + 1 <= 1 THEN :delay_1
    WHEN attempts + 1 = 2 THEN :delay_2
    WHEN attempts + 1 = 3 THEN :delay_3
    WHEN attempts + 1 = 4 THEN :delay_4
    WHEN attempts + 1 = 5 THEN :delay_5
    WHEN attempts + 1 = 6 THEN :delay_6
    WHEN attempts + 1 = 7 THEN :delay_7
    WHEN attempts + 1 = 8 THEN :delay_8
    WHEN attempts + 1 = 9 THEN :delay_9
    ELSE :delay_max
  END,
  locked_until = NULL,
  lease_id = NULL,
  updated_at = :now,
  last_error = 'lease expired before completion; scheduled retry',
  last_error_at = :now
WHERE id IN (
  SELECT id
  FROM outbox
  WHERE status = 'sending'
    AND locked_until IS NOT NULL
    AND locked_until < :now
    AND attempts + 1 < max_attempts
  ORDER BY locked_until ASC
  LIMIT :limit
);
```

回收路径使用同一 backoff policy。为了 SQL 可移植，默认用调用方预先计算好的 `delay_1..delay_9/delay_max` 参数；是否对回收路径也加入 jitter 留到实现时评估，但不得让过期任务立刻可领。

领取 due tasks，优先用单语句 `UPDATE ... RETURNING`：

```sql
UPDATE outbox
SET
  status = 'sending',
  lease_id = :lease_id,
  locked_until = :lease_until,
  updated_at = :now
WHERE id IN (
  SELECT id
  FROM outbox
  WHERE status = 'pending'
    AND next_at <= :now
  ORDER BY priority DESC, next_at ASC, created_at ASC
  LIMIT :limit
)
RETURNING *;
```

D1 / SQLite fallback：

```sql
UPDATE outbox
SET
  status = 'sending',
  lease_id = :lease_id,
  locked_until = :lease_until,
  updated_at = :now
WHERE id IN (
  SELECT id
  FROM outbox
  WHERE status = 'pending'
    AND next_at <= :now
  ORDER BY priority DESC, next_at ASC, created_at ASC
  LIMIT :limit
);

SELECT *
FROM outbox
WHERE lease_id = :lease_id
  AND status = 'sending';
```

完成、失败、取消时必须带 `lease_id` 条件：

```sql
UPDATE outbox
SET status = 'sent', sent_at = :now, updated_at = :now,
    locked_until = NULL, lease_id = NULL,
    provider_message_id = :provider_message_id,
    provider_response_json = :provider_response_json
WHERE id = :id
  AND status = 'sending'
  AND lease_id = :lease_id;
```

如果 affected rows 为 0，表示当前执行者不再持有 lease，不能继续改这条任务。

### 5.5 崩溃窗口

| 窗口 | 结果 | 处理 |
| --- | --- | --- |
| received_event 占位后、outbox 写入或 committed 前崩溃 | `committed = 0` | 下次相同 dedupe key 入站允许重新处理并覆盖 outbox，不能当重复丢弃。 |
| outbox 写入后，后台调度未启动前崩溃 | 任务保持 `pending` | VPS loop 或 Worker Cron 后续领取。 |
| 领取后、发送前崩溃 | 任务停在 `sending` | `locked_until` 过期后记一次失败；未达上限则退避后回到 `pending`，达到上限则 `dead`。 |
| provider 发送成功后、写 sent_log 前崩溃 | 可能重复发送 | at-least-once 已知窗口；依赖 provider 幂等降低重复。 |
| 写 sent_log 后、mark outbox sent 前崩溃 | 不再外发 | 下次看到 sent_log 后直接标记 `sent`。 |
| 失败后、写 retry 前崩溃 | lease 过期后重试 | 回收路径会记一次失败并按退避重排。 |
| Worker `waitUntil` 被平台中止 | 本轮未完成任务进入 lease 回收流程 | Cron 兜底；回收同样计 attempts，避免 poison message 空转。 |

### 5.6 指数退避

默认参数：

```txt
initialDelayMs = 30_000
multiplier = 2
maxDelayMs = 1_800_000       # 30 minutes
jitterRatio = 0.2            # +/- 20%
maxAttempts = 10
leaseMs = 90_000
sendTimeoutMs = 10_000
```

计算：

```txt
attempts 从 0 开始
第 1 次失败后 attempts = 1
delay = min(initialDelayMs * multiplier^(attempts - 1), maxDelayMs)
delay = applyJitter(delay, jitterRatio)
next_at = now + delay
```

终态：

1. `retryable = false` 的错误直接进入 `dead`。
2. `attempts >= maxAttempts` 后进入 `dead`。
3. 用户手动取消进入 `cancelled`。
4. 用户手动重放 dead/cancelled 时，默认创建新的 outbox row，保留原始历史；是否允许原地 reset 留作后续决定。

错误分类：

| 类型 | 示例 | 处理 |
| --- | --- | --- |
| 永久错误 | 401 token invalid、404 chat not found、模板不合法 | `dead` |
| 临时错误 | 429、5xx、网络超时、DNS 问题 | retry |
| 配置错误 | channel disabled、notifier missing | `cancelled` 或 `dead`，取决于是否用户主动禁用 |

### 5.7 放弃严格顺序的原因

严格顺序会显著增加复杂度和资源占用：

1. 多 channel 投递速度不同，慢 channel 会阻塞快 channel。
2. 重试任务可能卡住后续正常任务。
3. Worker 和 VPS 都可能并发领取任务。
4. `waitUntil` 和 Cron 会天然产生不同调度路径。
5. 低配 VPS 上为顺序引入 per-key 队列或分布式锁不划算。

本项目只提供 best-effort ordering：

```txt
ORDER BY priority DESC, next_at ASC, created_at ASC
```

对要求严格顺序的通知场景，后续可按 `channel_id` 或自定义 `ordering_key` 增加串行模式，但不进入 MVP。

## 6. 双运行时适配

### 6.1 VPS / Docker / 树莓派

运行方式：

```txt
Node.js Hono server
SQLite file
Vue static assets
setInterval(processPending, ~2s)
```

调度策略：

1. 启动时先跑一次 `processPending({ limit: 25 })`。
2. 每 2 秒触发一次。
3. 使用进程内 mutex 防止同一进程内重叠执行。
4. 如果上一轮还没结束，跳过本轮 tick。
5. webhook 请求写 outbox 后可触发一次非阻塞 `kick()`，但仍必须 bounded。
6. 多实例部署不是 MVP；但 lease 设计允许未来多实例 best-effort 运行。

建议参数：

```txt
intervalMs = 2_000
limit = 25
recoverLimit = 100
maxConcurrency = 3
leaseMs = 90_000
sendTimeoutMs = 10_000
```

注意：

1. `better-sqlite3` 是同步 driver；低并发下可接受。
2. SQLite 开启 WAL。
3. 设置 `busy_timeout`，例如 5000ms。
4. VPS 需要基本时间同步；退避和 lease 都依赖系统时间。
5. Docker Compose 中 SQLite 文件必须挂载 volume。

### 6.2 Cloudflare Worker

运行方式：

```txt
Hono Worker fetch handler
D1 binding
ctx.waitUntil() 即时首投
Cron Trigger 重试兜底
```

fetch handler 策略：

1. 验证、解析、匹配、渲染、写 outbox。
2. 立即返回 `202 Accepted`。
3. 如果有 outbox 任务，调用：

```ts
ctx.waitUntil(processPending({ limit: 5, recoverLimit: 20, maxConcurrency: 2 }));
```

4. `waitUntil` 必须 bounded；不允许 while backlog。
5. 如果 backlog 很大，交给 Cron 后续处理。

scheduled handler 策略：

```ts
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPending({ limit: 50, recoverLimit: 200, maxConcurrency: 3 }));
  }
}
```

Cron 配置：

```toml
[triggers]
crons = ["* * * * *"]
```

Worker 差异必须明确：

1. Cron 最小实用粒度按分钟设计，因此 retry 延迟小于 1 分钟时只能 best-effort。
2. `ctx.waitUntil()` 适合即时首投，但不是无限后台 worker。
3. Worker 环境不能依赖 Node-only 包、文件系统、长期进程或 setInterval。
4. D1 不应依赖长事务；领取任务尽量用单语句 update，或短 batch。
5. Worker bundle 不包含 SMTP/Nodemailer。
6. 所有外部发送必须设置超时。

### 6.3 运行时共享边界

共享：

```txt
SourceAdapter 类型
规则匹配
模板渲染
outbox schema
Store interface
Notifier interface
processPending
Telegram / Resend / webhook notifier
```

不共享：

```txt
调度器：setInterval vs waitUntil + Cron
数据库实现：better-sqlite3 vs D1 binding
静态资源托管方式
SMTP transport
本地文件路径 / volume 配置
wrangler bindings
```

## 7. 去重策略

### 7.1 入站去重

优先使用 source adapter 提供的稳定 key：

```txt
Komari: 待根据真实 payload 确定
Wallos: 待根据真实 payload 确定
Generic: 用户在 source config 中配置 JSON path，例如 $.id 或 $.event_id
```

流程：

1. Adapter 解析出 `inbound_dedupe_key`。
2. HTTP handler 先完成规则匹配和模板渲染，得到 `outboxItems[]`。
3. 调用 `store.ingest(receivedEvent, outboxItems)` 原子写入 received_event 和 outbox。
4. 如果已有 `committed = 1` 的相同 key：
   - 更新 `last_seen_at` 和 `seen_count`。
   - 返回 `202 Accepted`。
   - 不创建新的 outbox。
5. 如果已有 `committed = 0` 的相同 key：
   - 视为上次崩溃未完成。
   - 重新处理并覆盖 outbox。
   - 最后置 `committed = 1`。
6. 如果没有 key：
   - 计算 `payload_hash` 用于观察。
   - 默认不阻止入队。

退化策略：

1. 没有稳定 key 时，不做强去重，避免误吞合法重复。
2. 可选近似去重：`payload_hash + source_id + minute_bucket`，需用户明确启用。
3. Generic source 新建时，WebUI 必须默认引导用户填写 inbound dedupe JSON path；如果留空，需要明确提示“超时重试可能导致重复通知”。

### 7.2 出站去重

出站 key：

```txt
outbound_dedupe_key = source_id + inbound_dedupe_key + rule_id + channel_id
```

只有 `inbound_dedupe_key` 存在时才生成。

发送前：

1. 查 `sent_log.outbound_dedupe_key`。
2. 如果存在，不外发，直接 mark outbox sent。

发送时：

1. Resend 等支持幂等的 provider 传 `Idempotency-Key`。
2. 通用 webhook 如果用户配置 header，也可传幂等 header。
3. Telegram Bot API 没有通用幂等语义，接受极少数崩溃窗口重复。

发送后：

1. 先 insert `sent_log`。
2. 再 mark outbox `sent`。

### 7.3 重复无法完全避免的场景

以下场景可能产生重复通知：

1. Provider 已发送成功，但进程在写 sent_log 前崩溃。
2. Provider 实际成功，但网络响应超时，系统认为失败。
3. Provider 不支持幂等 key。
4. 用户手动重放同一 dead 任务。

WebUI 必须在日志中显示：

```txt
attempts
last_error
provider_message_id
outbound_dedupe_key
是否使用 provider idempotency
```

## 8. 接口契约

### 8.1 通用类型

```ts
export type UnixMs = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SecretBundle {
  config: JsonObject;
  secrets: JsonObject;
}

export interface WebhookEvent {
  sourceId: string;
  sourceType: string;
  eventType: string;
  occurredAt?: UnixMs;
  inboundDedupeKey?: string;
  payload: JsonObject;
  payloadHash: string;
  raw?: {
    contentType?: string;
    size: number;
  };
}

export interface NotificationMessage {
  title?: string;
  text: string;
  html?: string;
  markdown?: string;
  tags?: string[];
  metadata?: JsonObject;
}
```

### 8.2 `SourceAdapter`

```ts
export interface SourceParseInput {
  source: SourceConfig;
  method: string;
  url: URL;
  headers: Headers;
  rawBody: ArrayBuffer;
  now: UnixMs;
}

export interface SourceConfig {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: JsonObject;
  secrets: JsonObject;
}

export interface SourceAdapter {
  type: string;

  verify?(input: SourceParseInput): Promise<void>;

  parse(input: SourceParseInput): Promise<WebhookEvent[]>;

  deriveDedupeKey?(event: WebhookEvent, input: SourceParseInput): string | undefined;
}
```

约束：

1. `verify()` 失败抛出认证/签名错误，HTTP 层返回 401 或 403。
2. `parse()` 只返回标准化事件，不创建 outbox。
3. Adapter 不直接访问数据库。
4. Adapter 不调用 notifier。
5. Adapter 必须限制 body size，默认不超过 1 MiB。

### 8.3 `Notifier`

```ts
export interface ChannelConfig {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: JsonObject;
  secrets: JsonObject;
}

export interface NotifierSendContext {
  channel: ChannelConfig;
  idempotencyKey: string;
  now: () => UnixMs;
  signal: AbortSignal;
  logger?: Logger;
}

export interface NotifierResult {
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
}

export interface NotifierError extends Error {
  retryable: boolean;
  statusCode?: number;
  providerCode?: string;
}

export interface Notifier {
  type: string;
  send(message: NotificationMessage, context: NotifierSendContext): Promise<NotifierResult>;
}
```

约束：

1. Notifier 必须尊重 `AbortSignal`。
2. Notifier 不更新 outbox。
3. Notifier 错误必须能被分类为 retryable / non-retryable。
4. Node-only notifier 文件名必须带 `.node.ts`，避免 Worker 静态导入。

### 8.4 `Store`

```ts
export interface Store {
  getSourceById(id: string): Promise<SourceConfig | null>;
  listEnabledRulesForEvent(event: WebhookEvent): Promise<RuleConfig[]>;
  listEnabledChannelsForRule(ruleId: string): Promise<RuleChannelConfig[]>;

  ingest(input: IngestInput): Promise<IngestResult>;

  recoverExpiredLeases(input: RecoverExpiredLeasesInput): Promise<RecoverExpiredLeasesResult>;
  claimDueOutbox(input: ClaimDueOutboxInput): Promise<OutboxItem[]>;

  getEnabledChannel(id: string): Promise<ChannelConfig | null>;

  findSentLogByDedupeKey(outboundDedupeKey: string): Promise<SentLogEntry | null>;
  insertSentLog(input: NewSentLogEntry): Promise<InsertSentLogResult>;

  markOutboxSentByLease(input: MarkOutboxSentInput): Promise<boolean>;
  scheduleOutboxRetryByLease(input: ScheduleOutboxRetryInput): Promise<boolean>;
  markOutboxDeadByLease(input: MarkOutboxDeadInput): Promise<boolean>;
  cancelOutboxByLease(input: CancelOutboxInput): Promise<boolean>;

  listOutbox(query: ListOutboxQuery): Promise<Paginated<OutboxItem>>;
  listSentLog(query: ListSentLogQuery): Promise<Paginated<SentLogEntry>>;
  getOutboxById(id: string): Promise<OutboxItem | null>;
}
```

`ingest()` 是入站持久化唯一入口：

```ts
export interface IngestInput {
  receivedEvent: NewReceivedEvent;
  outboxItems: NewOutboxItem[];
  now: UnixMs;
}

export interface IngestResult {
  duplicate: boolean;
  committed: boolean;
  receivedEventId: string;
  seenCount: number;
  outboxCount: number;
}
```

`InsertSentLogResult` 必须能表达唯一冲突被吸收后的结果：

```ts
export interface InsertSentLogResult {
  inserted: boolean;
  sentLogId: string;
  providerMessageId?: string;
  providerResponseJson?: JsonObject;
}
```

关键输入类型：

```ts
export interface ClaimDueOutboxInput {
  now: UnixMs;
  leaseId: string;
  leaseUntil: UnixMs;
  limit: number;
}

export interface RecoverExpiredLeasesInput {
  now: UnixMs;
  limit: number;
  backoffDelaysMsByAttempt: Record<number, number>;
  maxBackoffDelayMs: number;
}

export interface RecoverExpiredLeasesResult {
  retried: number;
  dead: number;
}

export interface ScheduleOutboxRetryInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  attempts: number;
  nextAt: UnixMs;
  error: string;
}

export interface MarkOutboxDeadInput {
  id: string;
  leaseId: string;
  now: UnixMs;
  attempts: number;
  error: string;
}
```

Store 约束：

1. 所有更新 `sending` 任务的方法必须带 `leaseId`。
2. Store 返回 `boolean` 表示是否实际更新了当前 lease 持有的 row。
3. Store 负责 SQL 方言兼容，不把差异暴露给 core。
4. Store 必须截断错误文本，避免异常响应撑爆数据库。
5. Store 必须对 JSON 做 parse/stringify 边界校验。

## 9. Email 特殊处理

### 9.1 通用 Email transport：Resend HTTP API

Resend 是 MVP 的跨运行时 Email transport：

1. Node 和 Worker 都使用 `fetch` 调用。
2. 支持传入 `Idempotency-Key` 时，使用 `provider_idempotency_key`。
3. API key 存在 channel 的 encrypted secret 中。
4. `from`、`to`、`replyTo` 等非敏感配置存在 `config_json`。

### 9.2 VPS-only transport：SMTP / Nodemailer

SMTP 只作为 VPS 可选增强：

1. 文件命名为 `smtp.node.ts`。
2. 只在 `apps/server` 的 notifier registry 中动态启用。
3. Worker build 不得导入 Nodemailer。
4. SMTP 不算 Worker 版缺失功能；跨运行时功能对等以 Resend transport 为准。

### 9.3 Worker 不做 SMTP 的原因

1. Worker 不是长期进程环境。
2. Node SMTP 包通常依赖 Node net/tls/stream 语义。
3. Cloudflare Worker TCP 能力和端口策略不适合作为 MVP SMTP 基础。
4. Email HTTP API 更简单、可观测、可幂等，也更适合 serverless。

## 10. WebUI 范围

### 10.1 最小可用集

WebUI MVP 必须包含：

1. 登录 / 初始化管理员密码。
2. Dashboard：最近入站数、pending、sending、dead、sent、最近错误。
3. Sources：
   - 新建 / 编辑 / 禁用 source。
   - 显示 webhook URL。
   - 设置 adapter 类型和 secret。
   - Generic source 新建时默认引导填写 inbound dedupe JSON path。
   - 显示最近一次收到事件。
4. Channels：
   - 新建 / 编辑 / 禁用 Telegram、Resend、Webhook。
   - secret 写入和替换。
   - 测试发送。
5. Rules：
   - 新建 / 编辑 / 禁用规则。
   - 选择 source。
   - 编辑 match JSON。
   - 编辑模板。
   - 绑定 channels。
   - 用样例 payload 预览匹配和渲染结果。
6. Outbox：
   - 按 status/source/channel/time 搜索。
   - 查看 payload、message、attempts、next_at、last_error。
   - 对 dead/cancelled 任务重放。
   - 对 pending/sending 任务取消。
7. Sent Log：
   - 查看成功投递记录。
   - 查看 provider_message_id 和去重 key。
8. Settings：
   - 日志保留策略。
   - 默认 retry 参数。
   - 管理员密码修改。

### 10.2 明确不做

MVP WebUI 不做：

1. 拖拽式流程编排。
2. 多用户权限系统。
3. 富文本模板编辑器。
4. 移动端复杂操作优化；只保证响应式可用。
5. Provider-specific 深度分析报表。
6. 明文 secret 查看。

## 11. 部署

### 11.1 Docker / VPS

Docker 使用 multi-stage：

```txt
stage 1: install deps
stage 2: build packages + web + server
stage 3: runtime only, copy dist + production deps
```

原则：

1. 低配 VPS 只跑构建产物，不在 VPS 上执行 Vite 构建。
2. SQLite 数据库放在 volume，例如 `/data/kaname-relay.sqlite`.
3. WebUI 静态文件由 Hono server 直接 serve。
4. 日志输出到 stdout，Docker 侧限制 log size。
5. 默认监听 `0.0.0.0:3000`。

Compose 要点：

```yaml
services:
  kaname-relay:
    image: kaname-relay:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      DATABASE_URL: "file:/data/kaname-relay.sqlite"
      APP_SECRET: "${APP_SECRET}"
      ADMIN_PASSWORD: "${ADMIN_PASSWORD}"
      NODE_ENV: "production"
      TZ: "Asia/Shanghai"
```

资源预期：

```txt
应用本体 RAM: 50-120 MB
Docker daemon 额外 RAM: 60-150 MB
单容器总体验: 常见 150-300 MB
SQLite: 无独立进程
镜像体积: 120-300 MB，取决于 base image 和 native deps
```

1C512M VPS 可运行，但应避免同机部署重型数据库、Redis、前端 dev server 或构建流程。

### 11.2 Cloudflare Worker

Wrangler 要点：

```toml
name = "kaname-relay"
main = "src/index.ts"
compatibility_date = "2026-06-17"

[[d1_databases]]
binding = "DB"
database_name = "kaname-relay"
database_id = "..."

[triggers]
crons = ["* * * * *"]
```

如果使用 Worker Assets：

```toml
[assets]
directory = "../web/dist"
binding = "ASSETS"
```

Secret：

```txt
wrangler secret put APP_SECRET
wrangler secret put ADMIN_PASSWORD
```

D1 migration：

```txt
wrangler d1 migrations apply kaname-relay --local
wrangler d1 migrations apply kaname-relay --remote
```

Worker 部署原则：

1. Core 不依赖 Node-only API。
2. 只有必要时启用 Node.js compatibility。
3. 所有任务处理都有 `limit`。
4. 所有外部 `fetch` 都有超时。
5. 大 backlog 由 Cron 多轮消化。
6. 静态 WebUI 可以随 Worker 一起部署，也可以单独部署到 Pages；MVP 优先同 Worker 托管，减少组件。

## 12. API 草案

管理 API 均在 `/api/admin/*` 下，需要管理员 session。

Webhook endpoint：

```txt
POST /hooks/:sourceId
```

成功响应：

```json
{
  "accepted": true,
  "receivedEventId": "01...",
  "outboxCount": 2
}
```

重复入站响应：

```json
{
  "accepted": true,
  "duplicate": true,
  "receivedEventId": "01..."
}
```

管理 API：

```txt
GET    /api/admin/sources
POST   /api/admin/sources
PATCH  /api/admin/sources/:id
POST   /api/admin/sources/:id/rotate-secret

GET    /api/admin/channels
POST   /api/admin/channels
PATCH  /api/admin/channels/:id
POST   /api/admin/channels/:id/test

GET    /api/admin/rules
POST   /api/admin/rules
PATCH  /api/admin/rules/:id
POST   /api/admin/rules/:id/preview

GET    /api/admin/outbox
GET    /api/admin/outbox/:id
POST   /api/admin/outbox/:id/replay
POST   /api/admin/outbox/:id/cancel

GET    /api/admin/sent-log
GET    /api/admin/dashboard
```

认证：

1. MVP 使用单管理员密码。
2. 密码使用 Argon2id 或 scrypt hash。
3. Session cookie 使用 HttpOnly、SameSite=Lax。
4. Worker 和 Node 均可实现的签名 session；不依赖本地内存 session。

## 13. 实现里程碑

### M0：仓库骨架与质量门禁

内容：

1. pnpm workspace。
2. packages/apps 目录。
3. TypeScript config。
4. lint、format、test runner。
5. 基础 CI 脚本。

完成标准：

1. `pnpm install` 成功。
2. `pnpm typecheck` 成功。
3. `pnpm test` 有一个最小测试并通过。
4. 没有运行时功能要求。

### M1：核心 outbox 跑通

内容：

1. Store interface。
2. SQLite schema 和 migrations。
3. `processPending()`。
4. Generic source adapter。
5. Telegram notifier 或 webhook notifier 二选一作为首个真实 notifier。
6. Node server webhook endpoint。

完成标准：

1. 本地 POST `/hooks/:sourceId` 返回 202。
2. 命中规则后创建 outbox。
3. `processPending()` 成功发送并写 sent_log。
4. 人为让 notifier 失败时，任务按指数退避进入 retry。
5. 超过最大次数进入 dead。
6. 模拟进程崩溃的 `sending` 任务能通过 lease 回收，回收会增加 attempts、设置退避，达到上限后转 dead。

### M2：WebUI MVP

内容：

1. 登录和初始化管理员密码。
2. Sources CRUD。
3. Channels CRUD + test send。
4. Rules CRUD + preview。
5. Outbox 列表、详情、重放、取消。
6. Sent log 查看。

完成标准：

1. 不手写数据库也能通过 UI 配好 generic source、规则和渠道。
2. UI 测试发送成功。
3. UI 能看到失败任务并重放。
4. secret 不回显明文。

### M3：Docker 部署

内容：

1. multi-stage Dockerfile。
2. docker-compose.yml。
3. SQLite volume。
4. 生产静态 WebUI serve。

完成标准：

1. 本机 `docker compose up` 后可访问 WebUI。
2. 重启容器后数据仍存在。
3. 容器内不需要 dev server。
4. 空闲 RAM 符合轻量目标。

### M4：Worker + D1 入口

内容：

1. D1 Store。
2. Worker Hono app。
3. `ctx.waitUntil()` 首投。
4. Cron Trigger 重试。
5. Worker assets 或 Pages 部署 WebUI。

完成标准：

1. `wrangler dev` 本地可收 webhook 并写 D1。
2. Worker 收到 webhook 后返回 202。
3. `waitUntil` 能即时处理小批量 outbox。
4. Cron 能处理 pending/retry/backlog。
5. Worker bundle 不包含 Nodemailer/better-sqlite3。

### M5：Komari / Wallos / Email 完整化

内容：

1. Komari source adapter。
2. Wallos source adapter。
3. Resend notifier。
4. VPS-only SMTP notifier。
5. 示例规则模板。

完成标准：

1. 使用真实或样例 Komari payload 能解析、去重、投递。
2. 使用真实或样例 Wallos payload 能解析、去重、投递。
3. Resend 在 Node 和 Worker 两边都能发送。
4. SMTP 只在 Node server 启用。

### M6：硬化与文档

内容：

1. 数据保留清理任务。
2. 速率限制和 body size 限制。
3. 管理 API CSRF 防护。
4. 错误分类完善。
5. README 和部署指南。
6. 备份/恢复说明。

完成标准：

1. 长时间运行日志和 SQLite 不无限膨胀。
2. 常见错误在 WebUI 中可读。
3. Docker 和 Worker 部署步骤可复现。
4. 基础安全项完成。

## 14. 边界情况清单

实现和测试必须覆盖：

1. source 不存在：404。
2. source 禁用：403 或 202 ignored，需在未决问题中确认。
3. 认证/签名失败：401/403，不写 outbox。
4. body 过大：413。
5. JSON 解析失败：400。
6. adapter 返回 0 个事件：202 accepted，outboxCount = 0。
7. 没有规则命中：202 accepted，outboxCount = 0，并记录 received_events。
8. 多规则、多渠道命中：创建多条 outbox。
9. 重复 inbound_dedupe_key 且 `committed = 1`：不创建新 outbox，只更新 seen 信息。
10. 重复 inbound_dedupe_key 且 `committed = 0`：重新处理并覆盖 outbox，最终置 `committed = 1`。
11. `ingest()` 的 outboxItems 为空：仍要把 received_event 置为 `committed = 1`。
12. channel 禁用后已有 pending 任务：processPending 取消该任务。
13. notifier 返回 429：retry。
14. notifier 返回 401：dead。
15. notifier 超时：retry。
16. sent_log 存在：不外发，直接 mark sent。
17. sending 任务 lease 过期且未达 max_attempts：attempts + 1，退避后回到 pending。
18. sending 任务 lease 过期且达到 max_attempts：转 dead，错误标记 suspected poison message。
19. lease 不匹配时完成任务：更新失败，不可覆盖。
20. Worker waitUntil 只处理 limit 数量，剩余 backlog 等 Cron。
21. 手动 replay dead：保留原始 outbox，创建新任务。
22. APP_SECRET 缺失：服务启动失败，不能静默创建新 key。
23. APP_SECRET 变化：旧 secret 解密失败，UI 提示需重新配置渠道。
24. Generic source 未配置 inbound dedupe JSON path：UI 必须警告重复风险。
25. Match DSL 不允许 MVP 外的 regex；如果后续开启，必须有长度限制和超时或安全引擎。

## 15. 未决问题 / 待确认

这些点需要用户拍板，不能在实现中默默假设：

1. 项目名是否确定为 `kaname-relay`，还是需要换成更通用名字。
2. MVP 首个真实 notifier 选 Telegram 还是通用 webhook；M1 建议选 Telegram，因为目标场景最直接。
3. Admin auth 是否接受单管理员密码 + signed cookie，还是必须支持反代 Basic Auth / OIDC。
4. Source 禁用后的行为：返回 403，还是返回 202 ignored 避免上游持续告警。
5. 模板引擎选择：建议 Mustache 风格无逻辑模板；是否需要 Handlebars helper。
6. Match DSL 是否先只支持 JSON 条件，还是 WebUI 要提供表单式条件构建器。
7. 入站无 dedupe key 时，是否启用近似去重 `payload_hash + time_bucket`；默认建议不开。
8. Komari 和 Wallos 的真实 webhook payload 样例需要提供，才能确定 event type 和 dedupe key。
9. Email 默认 provider 是否确定为 Resend；是否还要支持 Mailgun/Postmark HTTP API。
10. Worker WebUI 托管方式：同 Worker assets，还是单独 Cloudflare Pages。
11. 日志保留默认值：建议 sent_log/outbox 成功记录保留 30 天，dead 永久保留直到用户清理。
12. 是否需要导入/导出配置 JSON，方便 VPS 和 Worker 之间迁移。
13. 是否需要多语言 UI；MVP 建议中文为主，内部 key 英文。
14. 是否允许 channel 配置变更影响已 pending 的任务；本文档当前设计为 pending 发送时使用当前 channel secret 和配置。
15. 是否要支持“静默时段”或“告警聚合”；建议不进 MVP，避免范围膨胀。

## 16. 官方约束参考

本计划依赖的关键外部约束：

1. Hono 基于 Web Standards，可运行在 Cloudflare Workers、Node.js 等运行时：https://hono.dev/docs/
2. Drizzle 支持 SQLite schema 和 Cloudflare D1：https://orm.drizzle.team/docs/connect-cloudflare-d1
3. Cloudflare Workers 使用 `ctx.waitUntil()` 处理响应后的后台任务，但后台任务必须 bounded：https://developers.cloudflare.com/workers/runtime-apis/context/
4. Cloudflare Workers Cron Trigger 用 scheduled handler 运行周期任务，MVP 按 1 分钟粒度设计：https://developers.cloudflare.com/workers/configuration/cron-triggers/
5. Cloudflare D1 使用 SQLite 语义，但 Store 层必须隐藏 SQL 支持差异：https://developers.cloudflare.com/d1/
6. Resend 等 HTTP Email API 适合作为跨运行时 email transport；支持幂等 key 时应使用：https://resend.com/docs/dashboard/emails/idempotency-keys
7. Worker TCP/socket 能力不作为 MVP SMTP 基础，SMTP/Nodemailer 保持 VPS-only：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
