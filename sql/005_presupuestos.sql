-- Retail 360 — presupuestos + reglas de descuento escalonado

CREATE TABLE IF NOT EXISTS discount_rules (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  comercio_id VARCHAR(36) NULL,
  nombre VARCHAR(160) NOT NULL,
  descripcion VARCHAR(400) NOT NULL DEFAULT '',
  -- amount: umbral por subtotal $ · qty: umbral por unidades totales
  basis ENUM('amount','qty') NOT NULL DEFAULT 'amount',
  price_list_id VARCHAR(36) NULL,
  activa TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_dr_comercio (comercio_id),
  CONSTRAINT fk_dr_price_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discount_rule_tiers (
  rule_id VARCHAR(36) NOT NULL,
  desde DECIMAL(12,2) NOT NULL DEFAULT 0,
  porcentaje DECIMAL(5,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, desde),
  CONSTRAINT fk_drt_rule FOREIGN KEY (rule_id) REFERENCES discount_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quotes (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  comercio_id VARCHAR(36) NULL,
  folio VARCHAR(32) NOT NULL,
  client_id VARCHAR(36) NULL,
  cliente_nombre VARCHAR(200) NOT NULL DEFAULT '',
  cliente_email VARCHAR(200) NOT NULL DEFAULT '',
  cliente_telefono VARCHAR(64) NOT NULL DEFAULT '',
  price_list_id VARCHAR(36) NULL,
  discount_rule_id VARCHAR(36) NULL,
  -- none | rule | manual  (rule usa tiers_json; manual usa descuento_manual_pct)
  discount_mode ENUM('none','rule','manual') NOT NULL DEFAULT 'none',
  discount_basis ENUM('amount','qty') NOT NULL DEFAULT 'amount',
  tiers_json JSON NULL,
  descuento_manual_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  status ENUM('borrador','enviado','aceptado','rechazado','vencido','convertido') NOT NULL DEFAULT 'borrador',
  validez_dias INT NOT NULL DEFAULT 15,
  validez_hasta DATE NULL,
  notas TEXT NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  descuento_monto DECIMAL(12,2) NOT NULL DEFAULT 0,
  descuento_pct_aplicado DECIMAL(5,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_quotes_folio (folio),
  KEY idx_quotes_comercio (comercio_id),
  KEY idx_quotes_status (status),
  KEY idx_quotes_created (created_at),
  CONSTRAINT fk_quotes_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  CONSTRAINT fk_quotes_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE SET NULL,
  CONSTRAINT fk_quotes_rule FOREIGN KEY (discount_rule_id) REFERENCES discount_rules(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quote_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quote_id VARCHAR(36) NOT NULL,
  product_id VARCHAR(36) NULL,
  sku VARCHAR(64) NOT NULL DEFAULT '',
  nombre VARCHAR(200) NOT NULL,
  cantidad DECIMAL(12,3) NOT NULL DEFAULT 1,
  precio_lista DECIMAL(12,2) NOT NULL DEFAULT 0,
  precio_unitario DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_descuento_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  importe DECIMAL(12,2) NOT NULL DEFAULT 0,
  KEY idx_ql_quote (quote_id),
  CONSTRAINT fk_ql_quote FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO counters (name, value) VALUES ('folio_presupuesto', 0)
ON DUPLICATE KEY UPDATE name = name;
