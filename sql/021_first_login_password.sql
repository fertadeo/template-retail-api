-- Preserve existing accounts. New accounts must replace their temporary password.
SET @db := DATABASE();
SET @q := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='users' AND COLUMN_NAME='must_change_password'), 'SELECT 1', 'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
ALTER TABLE users MODIFY must_change_password TINYINT(1) NOT NULL DEFAULT 1;
