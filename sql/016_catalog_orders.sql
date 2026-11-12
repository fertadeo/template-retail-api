-- Catálogo público + pedidos por WhatsApp (espejo de fenec_catalog_orders).
-- Fechas en UTC (UTC_TIMESTAMP) para evitar desfases de zona horaria.

CREATE TABLE IF NOT EXISTS retail_settings (
  comercio_id VARCHAR(36) NOT NULL,
  setting_key VARCHAR(80) NOT NULL,
  value_text TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (comercio_id, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_orders (
  id VARCHAR(40) NOT NULL,
  comercio_id VARCHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  expires_at DATETIME NOT NULL,
  buyer_name VARCHAR(190) NOT NULL DEFAULT '',
  buyer_phone VARCHAR(40) NOT NULL DEFAULT '',
  buyer_note TEXT NOT NULL,
  items_json LONGTEXT NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'ARS',
  total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  whatsapp_sent_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_catalog_orders_comercio (comercio_id, created_at),
  KEY idx_catalog_orders_status (status),
  KEY idx_catalog_orders_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
