-- v5.7.5：积分榜重算自愈——「后续处理没跑完」的欠账标记。
--
-- 病根（2026-10-15 match 193 事故）：终场提交是两段式且无跨语句事务——① 先提交 match 的
-- 终场写入；② 再构建并提交积分重算/晋级填位/下一阶段首轮生成。第二段因网络卡顿、实例中断
-- 或 500 失败时（只有 AdvancerError 会回滚终场），留下「比赛已 finished、榜未重算、审计缺行」
-- 的半截状态，且没有任何痕迹说明该补算——事后只能靠人工比对 fin/played 才发现。
--
-- 本表语义 = 「该阶段的后续处理没跑完」，不是「欠一次重算」：补跑成功即删除。
-- stage_id 是行的身份（PRIMARY KEY）：同一阶段的并发写入天然收敛成一行；
-- ON CONFLICT 只刷新 source，保留 created_at（欠账年龄）与 attempts（失败次数）。
-- 补跑按阶段重放：非淘汰阶段=榜重算（+报分链上的下一阶段首轮生成），淘汰阶段=晋级填位。
CREATE TABLE IF NOT EXISTS rebuild_pending (
  stage_id      INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

-- 对账用：榜行记下「这条榜算的时候带进来了几场」（带入口径下可能 >0；不带入的阶段恒为 0）。
-- 为什么不能拿源阶段现在的 played 当期望值：源阶段继续开打后那个数会涨，而下游榜还没重算，
-- 于是每张带入榜都会误报成不一致（对账的假阳性来源）。老行补默认 0——旧版代码算出的
-- 带入榜没有这个数可回溯，只能从下一次重算起才有准确值。
ALTER TABLE standing ADD COLUMN carried_played INTEGER NOT NULL DEFAULT 0;
