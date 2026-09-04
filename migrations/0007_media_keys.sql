-- 队徽/封面图：存 R2 的对象 key（版本化：换图即换 key，URL 天然防缓存）。
ALTER TABLE team ADD COLUMN logo_key TEXT;
ALTER TABLE tournament ADD COLUMN cover_key TEXT;
