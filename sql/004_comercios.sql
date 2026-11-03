-- Retail 360 — comercios (unidades de negocio) + compartir / rotar stock

CREATE TABLE IF NOT EXISTS comercios (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  codigo VARCHAR(64) NOT NULL,
  nombre VARCHAR(160) NOT NULL,
  rubro VARCHAR(120) NOT NULL DEFAULT '',
  direccion VARCHAR(400) NOT NULL DEFAULT '',
  activa TINYINT(1) NOT NULL DEFAULT 1,
  es_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_comercios_codigo (codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_share_groups (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  -- shared: un solo stock por SKU entre miembros
  -- rotate: stock propio + transferencias entre miembros
  modo ENUM('shared','rotate') NOT NULL DEFAULT 'shared',
  activa TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_share_members (
  group_id VARCHAR(36) NOT NULL,
  comercio_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (group_id, comercio_id),
  CONSTRAINT fk_ssm_group FOREIGN KEY (group_id) REFERENCES stock_share_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ssm_comercio FOREIGN KEY (comercio_id) REFERENCES comercios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shared_stock (
  group_id VARCHAR(36) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (group_id, sku),
  CONSTRAINT fk_ss_group FOREIGN KEY (group_id) REFERENCES stock_share_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO comercios (id, codigo, nombre, rubro, direccion, activa, es_default)
VALUES ('co_principal', 'principal', 'Comercio principal', '', '', 1, 1)
ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), activa = VALUES(activa);

-- Columnas de alcance (idempotente)
SET @db := DATABASE();

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='products' AND COLUMN_NAME='comercio_id'),
    'SELECT 1',
    'ALTER TABLE products ADD COLUMN comercio_id VARCHAR(36) NULL AFTER id, ADD KEY idx_products_comercio (comercio_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='price_lists' AND COLUMN_NAME='comercio_id'),
    'SELECT 1',
    'ALTER TABLE price_lists ADD COLUMN comercio_id VARCHAR(36) NULL AFTER id, ADD KEY idx_pl_comercio (comercio_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='clients' AND COLUMN_NAME='comercio_id'),
    'SELECT 1',
    'ALTER TABLE clients ADD COLUMN comercio_id VARCHAR(36) NULL AFTER id, ADD KEY idx_clients_comercio (comercio_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='orders' AND COLUMN_NAME='comercio_id'),
    'SELECT 1',
    'ALTER TABLE orders ADD COLUMN comercio_id VARCHAR(36) NULL AFTER id, ADD KEY idx_orders_comercio (comercio_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='branches' AND COLUMN_NAME='comercio_id'),
    'SELECT 1',
    'ALTER TABLE branches ADD COLUMN comercio_id VARCHAR(36) NULL AFTER id, ADD KEY idx_branches_comercio (comercio_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE products SET comercio_id = 'co_principal' WHERE comercio_id IS NULL;
UPDATE price_lists SET comercio_id = 'co_principal' WHERE comercio_id IS NULL;
UPDATE clients SET comercio_id = 'co_principal' WHERE comercio_id IS NULL;
UPDATE orders SET comercio_id = 'co_principal' WHERE comercio_id IS NULL;
UPDATE branches SET comercio_id = 'co_principal' WHERE comercio_id IS NULL;

-- SKU único por comercio (idempotente)
SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='products' AND INDEX_NAME='uq_products_sku'),
    'ALTER TABLE products DROP INDEX uq_products_sku',
    'SELECT 1'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='products' AND INDEX_NAME='uq_products_comercio_sku'),
    'SELECT 1',
    'ALTER TABLE products ADD UNIQUE KEY uq_products_comercio_sku (comercio_id, sku)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='price_lists' AND INDEX_NAME='uq_price_lists_codigo'),
    'ALTER TABLE price_lists DROP INDEX uq_price_lists_codigo',
    'SELECT 1'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='price_lists' AND INDEX_NAME='uq_price_lists_comercio_codigo'),
    'SELECT 1',
    'ALTER TABLE price_lists ADD UNIQUE KEY uq_price_lists_comercio_codigo (comercio_id, codigo)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
