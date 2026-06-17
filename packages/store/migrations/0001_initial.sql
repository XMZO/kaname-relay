PRAGMA foreign_keys = ON;

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
  ON received_events (source_id, inbound_dedupe_key)
  WHERE inbound_dedupe_key IS NOT NULL;

CREATE INDEX idx_received_events_seen
  ON received_events (source_id, last_seen_at DESC);

CREATE INDEX idx_received_events_payload_hash
  ON received_events (source_id, payload_hash);

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

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
