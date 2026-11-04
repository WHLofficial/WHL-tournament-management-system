-- #31 赛历与开球时刻（开球时刻排期器 P3-A）。
--
-- 五张表 + match 三列。设计见 docs/design-kickoff-scheduler.md。
--
-- 口径（三条，后面所有代码都按这个来）：
--
-- 一、时刻是**虚拟时刻**。kickoff_time 的 'HH:MM' 只是标签，不换算真实日期、不涉及时区；
--     时间轴是 ((week-1)*7 + (day-1)) 天，day 1 = 周一。间隔一律按「开球到开球」算。
--     所以前台只显示「第 N 周 · 周六 20:00」，不显示日期。
--
-- 二、窗口主键是 (tournament_id, stream, round, leg)，不是 (stage_id, round, leg)。
--     冠军杯小组赛和淘汰赛的 round 都从 1 起，靠 stream 区分；次级冲刺组(stage 3)与
--     挑战组(stage 4)共享同一周，窗口只能按赛事+stream 建一条。round_window 只规定
--     「哪一周的哪几天能踢」，具体哪天几点由排期器决定。
--     次级附加赛用 round = 0（常规 playoff 轮从 1 起，0 不冲突）。
--
-- 三、leg 为 NULL 表示单回合/联赛。SQLite 的 UNIQUE 把 NULL 当互不相等，直接建
--     UNIQUE(...,leg) 挡不住重复行，所以唯一性用 COALESCE(leg,0) 的表达式索引。
--
-- locked_at 非空 = 已公布（Q14），重排前必须先 unlock 并留理由。

CREATE TABLE IF NOT EXISTS season (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  weeks      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 周 → 季节。季节决定时刻池（夏季夜场多、秋季有午场），与真实月份无关。
CREATE TABLE IF NOT EXISTS season_week (
  season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  week      INTEGER NOT NULL CHECK (week >= 1),
  phase     TEXT NOT NULL CHECK (phase IN ('summer','autumn','winter','spring')),
  PRIMARY KEY (season_id, week)
);

CREATE TABLE IF NOT EXISTS round_window (
  id            INTEGER PRIMARY KEY,
  season_id     INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  stream        TEXT NOT NULL CHECK (stream IN ('league','playoff','group','elim')),
  round         INTEGER NOT NULL,
  leg           INTEGER,
  week          INTEGER NOT NULL CHECK (week >= 1),
  day_start     INTEGER NOT NULL CHECK (day_start BETWEEN 1 AND 7),
  day_end       INTEGER NOT NULL CHECK (day_end BETWEEN day_start AND 7),
  -- 覆盖该轮的默认时刻池（JSON，同 time_pool.slots）。例：杯赛小组第 3 轮两天窗口
  -- 实际全部 21:00 开球，就该轮覆盖一次；空 = 用 season_week.phase + time_pool。
  slot_override TEXT,
  locked_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_round_window
  ON round_window(tournament_id, stream, round, COALESCE(leg, 0));
CREATE INDEX IF NOT EXISTS idx_round_window_tournament
  ON round_window(tournament_id, stream, round);

-- 时刻池：同一季、同一赛事、同一天可用的开球时刻。slots 是 JSON 数组：
--   [{"time":"18:30","cap":3},{"time":"21:00","cap":2}]
-- cap = 该时刻最多同时几场（杯赛一天 5 场 = 18:30 容 3 + 21:00 容 2；联赛每档容 1）。
CREATE TABLE IF NOT EXISTS time_pool (
  id          INTEGER PRIMARY KEY,
  season_id   INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('summer','autumn','winter','spring')),
  competition TEXT NOT NULL CHECK (competition IN ('top','sub','cup')),
  day         INTEGER NOT NULL CHECK (day BETWEEN 1 AND 7),
  slots       TEXT NOT NULL,
  UNIQUE (season_id, phase, competition, day)
);

ALTER TABLE match ADD COLUMN kickoff_week     INTEGER;
ALTER TABLE match ADD COLUMN kickoff_day      INTEGER;
ALTER TABLE match ADD COLUMN kickoff_time     TEXT;
-- 1 = 越窗补赛（PATCH 改期到窗口之外），排期体检时单独标注
ALTER TABLE match ADD COLUMN kickoff_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match ADD COLUMN kickoff_reason   TEXT;

CREATE INDEX IF NOT EXISTS idx_match_kickoff_week ON match(kickoff_week);

-- 排期快照：每次 commit 存一版，可 restore（Q21）。
CREATE TABLE IF NOT EXISTS schedule_snapshot (
  id         INTEGER PRIMARY KEY,
  stage_id   INTEGER NOT NULL REFERENCES stage(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  leg        INTEGER,
  payload    TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_snapshot_round
  ON schedule_snapshot(stage_id, round, leg);
