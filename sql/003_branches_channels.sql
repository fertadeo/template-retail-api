-- Retail 360 — sucursales + vínculos de canal (WooCommerce / Mercado Libre)

CREATE TABLE IF NOT EXISTS branches (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  codigo VARCHAR(64) NOT NULL,
  nombre VARCHAR(160) NOT NULL,
  direccion VARCHAR(400) NOT NULL DEFAULT '',
  rubro VARCHAR(120) NOT NULL DEFAULT '',
  activa TINYINT(1) NOT NULL DEFAULT 1,
  es_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_branches_codigo (codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_branch_stock (
  product_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, branch_id),
  CONSTRAINT fk_pbs_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pbs_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_configs (
  channel ENUM('woocommerce','mercadolibre') NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  store_url VARCHAR(400) NULL,
  consumer_key VARCHAR(200) NULL,
  consumer_secret VARCHAR(400) NULL,
  access_token TEXT NULL,
  refresh_token TEXT NULL,
  seller_id VARCHAR(64) NULL,
  site_id VARCHAR(16) NULL DEFAULT 'MLA',
  price_list_id VARCHAR(36) NULL,
  stock_mode ENUM('total','default_branch','branch') NOT NULL DEFAULT 'total',
  stock_branch_id VARCHAR(36) NULL,
  last_sync_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_cc_price_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE SET NULL,
  CONSTRAINT fk_cc_stock_branch FOREIGN KEY (stock_branch_id) REFERENCES branches(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_channel_links (
  product_id VARCHAR(36) NOT NULL,
  channel ENUM('woocommerce','mercadolibre') NOT NULL,
  external_id VARCHAR(64) NOT NULL,
  external_sku VARCHAR(64) NOT NULL DEFAULT '',
  sync_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_synced_at DATETIME(3) NULL,
  last_error VARCHAR(500) NULL,
  PRIMARY KEY (product_id, channel),
  KEY idx_pcl_channel_ext (channel, external_id),
  CONSTRAINT fk_pcl_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO branches (id, codigo, nombre, direccion, activa, es_default)
VALUES ('br_central', 'central', 'Casa central', '', 1, 1)
ON DUPLICATE KEY UPDATE
  nombre = VALUES(nombre),
  activa = VALUES(activa);

INSERT INTO product_branch_stock (product_id, branch_id, stock)
SELECT p.id, 'br_central', p.stock
FROM products p
WHERE NOT EXISTS (
  SELECT 1 FROM product_branch_stock s
  WHERE s.product_id = p.id AND s.branch_id = 'br_central'
);

INSERT INTO channel_configs (channel, enabled, site_id, stock_mode)
VALUES
  ('woocommerce', 0, NULL, 'total'),
  ('mercadolibre', 0, 'MLA', 'total')
ON DUPLICATE KEY UPDATE channel = channel;
