-- 重置密码后强制改密：除改密/登出外全部接口 403，改完自动清零
ALTER TABLE user ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;
