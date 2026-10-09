-- #27 阶段带入积分 + 扣分指定生效阶段。
--
-- 两件事一起做，因为它们的落点是同一张表的两列（standing.carried_pts / deduct_pts）。
--
-- 一、带入积分：循环赛阶段可以从排在前面的循环赛阶段带分进来，按倍率折算（倍率是浮点，见
--     shared/types.ts 的 CarryConfig）。配置写在目标阶段自己的 config_json.carry 里，
--     不新增赛事级开关 —— 「哪两个阶段之间带分」本来就是阶段对阶段的事。
--     carried_pts 落库（而不是读侧现算）：它是重算的产物，读侧只取不算，免得读写两套口径；
--     改动源阶段必须级联重建下游，靠 worker/lib/standings.ts 的 buildStandingsChainStmts。
--
-- 二、扣分：原来是 entry.points_deducted 一个数字，每个非淘汰阶段都扣它一次 —— 也就是
--     「一次判罚，整届赛事每张榜都扣」。改成记录表后，一条扣分只作用于指定阶段
--     （stage_id NULL = 全赛事所有积分阶段），同一支队可以累加多条。
--
-- 口径：
-- - deduct_pts 记的是「本阶段命中的扣分合计」= 本阶段专属 + 全赛事通用；阶段级扣分不穿透到
--   下游阶段，下游只汇总自己命中的那些；
-- - 带入的折算基数就是源阶段榜上的实际积分（源 standing.pts）——注意它是净值，已经扣过该阶段
--   命中的扣分，不做「加回扣分」的还原：罚分把源阶段的分打低，下游带入的部分就跟着少；
-- - 存量 entry.points_deducted 搬成一条 stage_id IS NULL 的记录（等价于旧行为：每张榜都扣），
--   随后把该列置 0 并废弃。置 0 而不是留原值：万一还有遗漏的读取路径，结果是「不扣」（看得见），
--   而不是「双份扣」（看不见）。
CREATE TABLE IF NOT EXISTS points_deduction (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  stage_id   INTEGER REFERENCES stage(id) ON DELETE CASCADE,  -- NULL = 全赛事所有积分阶段
  points     INTEGER NOT NULL,                                -- 正数=扣分额，0 不建记录
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_points_deduction_entry ON points_deduction(entry_id);

ALTER TABLE standing ADD COLUMN carried_pts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE standing ADD COLUMN deduct_pts   INTEGER NOT NULL DEFAULT 0;

INSERT INTO points_deduction (entry_id, stage_id, points)
  SELECT id, NULL, points_deducted FROM entry WHERE points_deducted > 0;

-- 存量榜的 pts 里已经扣过 old 扣分（旧代码写的是 r.pts - entry.points_deducted），
-- 但 deduct_pts 还是 0 —— 不补上的话榜上「−N」标记会消失（分值本身是对的），
-- 直到那个阶段被下一次重算刷到。
-- 旧扣分是 entry 级、每张榜都扣，所以上面那条记录（stage_id IS NULL）对每张榜都命中。
UPDATE standing
   SET deduct_pts = COALESCE((
         SELECT SUM(d.points) FROM points_deduction d
          WHERE d.entry_id = standing.entry_id
            AND (d.stage_id IS NULL OR d.stage_id = standing.stage_id)
       ), 0)
 WHERE EXISTS (
         SELECT 1 FROM points_deduction d
          WHERE d.entry_id = standing.entry_id
            AND (d.stage_id IS NULL OR d.stage_id = standing.stage_id)
       );

UPDATE entry SET points_deducted = 0;
