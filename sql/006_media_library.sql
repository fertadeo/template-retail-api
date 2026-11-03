-- Biblioteca de medios: imágenes de productos + archivos adjuntos

CREATE TABLE IF NOT EXISTS media_assets (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  comercio_id VARCHAR(36) NULL,
  product_id VARCHAR(36) NULL,
  kind ENUM('image','attachment') NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime VARCHAR(120) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  data_url LONGTEXT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  uploaded_at DATE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_media_comercio (comercio_id),
  KEY idx_media_product (product_id),
  KEY idx_media_kind (kind),
  CONSTRAINT fk_media_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
