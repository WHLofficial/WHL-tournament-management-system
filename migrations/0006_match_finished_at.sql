-- 比赛完赛时间：主页「最近进行」按完赛顺序排序用。
-- 回填已有完赛场次取 updated_at（终场/改判是多数 finished 场的最后一次写入）。
ALTER TABLE match ADD COLUMN finished_at TEXT;
UPDATE match SET finished_at = updated_at WHERE status = 'finished';
