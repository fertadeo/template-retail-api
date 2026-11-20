-- Public WhatsApp checkout: durable idempotency and payment lifecycle independent of order status.
-- No payment provider is enabled by this migration. Safe to reapply on boot.
SET @db := DATABASE();
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='catalog_orders' AND COLUMN_NAME='checkout_key'), 'SELECT 1', 'ALTER TABLE catalog_orders ADD COLUMN checkout_key VARCHAR(80) NULL');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='catalog_orders' AND COLUMN_NAME='request_hash'), 'SELECT 1', 'ALTER TABLE catalog_orders ADD COLUMN request_hash CHAR(64) NULL');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='catalog_orders' AND COLUMN_NAME='payment_status'), 'SELECT 1', 'ALTER TABLE catalog_orders ADD COLUMN payment_status VARCHAR(24) NOT NULL DEFAULT ''not_requested''');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='catalog_orders' AND COLUMN_NAME='payment_method'), 'SELECT 1', 'ALTER TABLE catalog_orders ADD COLUMN payment_method VARCHAR(40) NULL');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='catalog_orders' AND COLUMN_NAME='payment_reference'), 'SELECT 1', 'ALTER TABLE catalog_orders ADD COLUMN payment_reference VARCHAR(190) NULL');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='catalog_orders' AND INDEX_NAME='uq_catalog_checkout'), 'SELECT 1', 'ALTER TABLE catalog_orders ADD UNIQUE KEY uq_catalog_checkout (comercio_id, checkout_key)');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
