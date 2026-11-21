CREATE TABLE IF NOT EXISTS cash_sessions (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 comercio_id VARCHAR(36) NOT NULL,
 open_comercio_id VARCHAR(36) NULL,
 opened_by VARCHAR(36) NOT NULL,
 closed_by VARCHAR(36) NULL,
 opening_amount DECIMAL(14,2) NOT NULL,
 currency VARCHAR(8) NOT NULL DEFAULT 'ARS',
 opened_at DATETIME(3) NOT NULL,
 closed_at DATETIME(3) NULL,
 counted_amount DECIMAL(14,2) NULL,
 cash_sales DECIMAL(16,2) NULL,
 transfer_sales DECIMAL(16,2) NULL,
 expected_amount DECIMAL(16,2) NULL,
 difference DECIMAL(16,2) NULL,
 ticket_count INT NULL,
 note VARCHAR(300) NOT NULL DEFAULT '',
 version INT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_cash_open_store (open_comercio_id),
 KEY idx_cash_store_opened (comercio_id, opened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SET @db := DATABASE();
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='orders' AND COLUMN_NAME='cash_session_id'), 'SELECT 1', 'ALTER TABLE orders ADD COLUMN cash_session_id VARCHAR(36) NULL, ADD KEY idx_orders_cash_session (cash_session_id)');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_store_created'), 'SELECT 1', 'ALTER TABLE orders ADD KEY idx_orders_store_created (comercio_id, created_at)');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
