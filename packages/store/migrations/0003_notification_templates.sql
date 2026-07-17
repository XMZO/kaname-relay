CREATE TABLE notification_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  template_json TEXT NOT NULL DEFAULT '{}',
  sample_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_notification_templates_updated
  ON notification_templates (updated_at DESC);

ALTER TABLE rules
  ADD COLUMN template_id TEXT
  REFERENCES notification_templates(id) ON DELETE SET NULL;

CREATE INDEX idx_rules_template_id
  ON rules (template_id);
