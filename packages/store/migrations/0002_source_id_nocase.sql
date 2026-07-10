CREATE UNIQUE INDEX idx_webhook_sources_id_nocase
  ON webhook_sources (id COLLATE NOCASE);
