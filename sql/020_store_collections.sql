-- Editorial storefront collections. Drafts and published snapshots are independent.
CREATE TABLE IF NOT EXISTS catalog_collections (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  comercio_id VARCHAR(36) NOT NULL,
  title VARCHAR(80) NOT NULL DEFAULT '',
  image MEDIUMBLOB NULL,
  image_small MEDIUMBLOB NULL,
  image_version VARCHAR(36) NULL,
  focal_x INT NOT NULL DEFAULT 50,
  focal_y INT NOT NULL DEFAULT 50,
  position INT NOT NULL DEFAULT 1,
  revision INT NOT NULL DEFAULT 1,
  published_title VARCHAR(80) NULL,
  published_image MEDIUMBLOB NULL,
  published_image_small MEDIUMBLOB NULL,
  published_image_version VARCHAR(36) NULL,
  published_focal_x INT NOT NULL DEFAULT 50,
  published_focal_y INT NOT NULL DEFAULT 50,
  published_position INT NOT NULL DEFAULT 1,
  published_revision INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_collection_store (comercio_id, active, published_position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS catalog_collection_items (
  collection_id VARCHAR(36) NOT NULL,
  stage ENUM('draft','published') NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, stage, product_id),
  KEY idx_collection_items_order (collection_id, stage, position),
  KEY idx_collection_product (product_id),
  CONSTRAINT fk_collection_item_collection FOREIGN KEY (collection_id) REFERENCES catalog_collections(id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_item_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
