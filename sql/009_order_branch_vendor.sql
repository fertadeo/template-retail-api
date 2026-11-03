-- Pedidos/POS: sucursal + vendedor (para reportes y alcance admin)

SET @db := DATABASE();

SET @q := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='orders' AND COLUMN_NAME='branch_id'
    ),
    'SELECT 1',
    'ALTER TABLE orders ADD COLUMN branch_id VARCHAR(36) NULL AFTER comercio_id, ADD KEY idx_orders_branch (branch_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='orders' AND COLUMN_NAME='vendedor_id'
    ),
    'SELECT 1',
    'ALTER TABLE orders ADD COLUMN vendedor_id VARCHAR(36) NULL AFTER branch_id, ADD KEY idx_orders_vendedor (vendedor_id)'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
