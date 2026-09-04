-- 观众号：无注册码注册的账号锁定绑队功能（locked=1），超管在账号管理解锁
ALTER TABLE user ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- 组织级开关：允许无注册码注册（建锁定观众号），默认关
ALTER TABLE organization ADD COLUMN allow_open_reg INTEGER NOT NULL DEFAULT 0;
