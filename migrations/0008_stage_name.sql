-- 阶段命名：公开页轮次显示 = 阶段名 + 轮名；NULL 时用赛制名兜底
ALTER TABLE stage ADD COLUMN name TEXT;
