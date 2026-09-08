-- D1 行读配额优化：audit_log / match_event 消全表扫描（2026-09-08）
-- audit_log 只增不减且此前完全无索引，三处查询全表扫、行读随审计量线性膨胀：
--   ①公开比赛详情页 rescore COUNT（public.ts，未登录热路径）
--   ②feed 冷路径 rescore 事件流（feedNews.ts，按 action + id 倒序）
--   ③管理端审计面板（admin/tournaments.ts）
CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id, id);
CREATE INDEX idx_audit_log_action ON audit_log(action, id);
-- 红牌快讯按 type IN ('red','red_2y') + created_at 倒序查，此前全表扫最大的 match_event 表再排序
CREATE INDEX idx_match_event_type_time ON match_event(type, created_at, id);
