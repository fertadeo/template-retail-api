-- URLs de CDN / querystrings de WooCommerce pueden superar 800 chars

SET @db := DATABASE();

SET @q := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='media_assets' AND COLUMN_NAME='source_url'
    ),
    'ALTER TABLE media_assets MODIFY COLUMN source_url VARCHAR(2048) NULL',
    'SELECT 1'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
