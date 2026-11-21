-- Profile data is separate so user lists never load avatar blobs. Existing users and passwords remain intact.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id VARCHAR(36) NOT NULL PRIMARY KEY,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  contact_email VARCHAR(254) NOT NULL DEFAULT '',
  avatar MEDIUMBLOB NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_user_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
