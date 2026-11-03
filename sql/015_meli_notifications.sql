-- Cola / log de notificaciones Mercado Libre (webhooks).
CREATE TABLE IF NOT EXISTS meli_notification_events (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  meli_event_id VARCHAR(64) NULL,
  topic VARCHAR(64) NOT NULL,
  resource VARCHAR(255) NOT NULL,
  user_id VARCHAR(64) NULL,
  application_id VARCHAR(64) NULL,
  attempts INT NOT NULL DEFAULT 1,
  payload_json JSON NULL,
  status ENUM('queued','processing','done','skipped','error') NOT NULL DEFAULT 'queued',
  result_message VARCHAR(500) NULL,
  product_id VARCHAR(36) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  UNIQUE KEY uq_meli_notif_event (meli_event_id),
  KEY idx_meli_notif_status (status, received_at),
  KEY idx_meli_notif_topic (topic, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
