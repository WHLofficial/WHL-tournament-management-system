-- 0035：删掉 player.team_id（阶段 B）。
-- 前置：阶段 A（0033/0034 + 代码 A）已上线并验证过 —— 读端只认 player_team_history，
-- 同步只关窗不删人。此迁移必须在维护窗口里紧接着代码 B 部署，窗口内最多失败一轮 cron。
-- 回滚：重新加可空 team_id，用开放窗口回填后部署代码 A。

DROP INDEX IF EXISTS idx_player_team;
ALTER TABLE player DROP COLUMN team_id;
