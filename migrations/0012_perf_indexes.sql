-- 全站提速（PERF_PLAN 包 A）：补高频查询缺失索引 + 删冗余索引
-- 首页 recent/upcoming/live/summary 按 status 过滤 match，原先全表扫（最大且增长最快的表）
CREATE INDEX idx_match_status ON match(status, finished_at DESC);
-- 教练「我的球队」与管理端球队列表相关子查询按 team_id 查 entry，原先只能全表扫
CREATE INDEX idx_entry_team ON entry(team_id);
-- 教练绑队按 code_hash 查 auth_code
CREATE INDEX idx_auth_code_hash ON auth_code(code_hash);
-- 与 UNIQUE(match_id, team_id) 自带索引完全重复，纯写放大
DROP INDEX IF EXISTS idx_tsub_match;
