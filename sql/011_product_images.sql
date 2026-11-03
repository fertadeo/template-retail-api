-- Imágenes de producto: principal + secundarias (orden)

SET @db := DATABASE();

SET @q := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='media_assets' AND COLUMN_NAME='is_primary'
    ),
    'SELECT 1',
    'ALTER TABLE media_assets ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0 AFTER product_id'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='media_assets' AND COLUMN_NAME='sort_order'
    ),
    'SELECT 1',
    'ALTER TABLE media_assets ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER is_primary'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

-- Si un producto tiene imágenes sin principal, marcar la primera como principal
UPDATE media_assets m
INNER JOIN (
  SELECT product_id, MIN(uploaded_at) AS first_up, MIN(id) AS first_id
  FROM media_assets
  WHERE product_id IS NOT NULL AND kind = 'image'
  GROUP BY product_id
  HAVING SUM(is_primary) = 0
) t ON t.product_id = m.product_id AND m.id = t.first_id
SET m.is_primary = 1;
