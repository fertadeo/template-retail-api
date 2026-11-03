-- URL remota de imagen (p. ej. WooCommerce) sin embeber base64 en el listado

SET @db := DATABASE();

SET @q := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='media_assets' AND COLUMN_NAME='source_url'
    ),
    'SELECT 1',
    'ALTER TABLE media_assets ADD COLUMN source_url VARCHAR(800) NULL AFTER data_url'
  )
);
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
