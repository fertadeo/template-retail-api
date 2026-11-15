-- Categorías por comercio. El enum histórico pasa a código libre.

CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  comercio_id VARCHAR(36) NOT NULL,
  codigo VARCHAR(64) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  activa TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_categories_comercio_codigo (comercio_id, codigo),
  KEY idx_categories_comercio (comercio_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE products
  MODIFY COLUMN categoria VARCHAR(64) NOT NULL DEFAULT 'otros';

INSERT INTO categories (id, comercio_id, codigo, nombre, activa)
SELECT CONCAT('cat_', c.id, '_', v.codigo), c.id, v.codigo, v.nombre, 1
FROM comercios c
CROSS JOIN (
  SELECT 'bebidas' AS codigo, 'Bebidas' AS nombre
  UNION ALL SELECT 'alimentos', 'Alimentos'
  UNION ALL SELECT 'limpieza', 'Limpieza'
  UNION ALL SELECT 'otros', 'Otros'
) v
WHERE NOT EXISTS (
  SELECT 1 FROM categories x
  WHERE x.comercio_id = c.id AND x.codigo = v.codigo
);
