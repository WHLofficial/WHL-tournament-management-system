-- 0037：赛季级排期版本（设计 docs/design-season-scheduler.md §3.2.3 / §3.2.4，计划 S1）。
--
-- 只新增表与索引，不改旧表：
--   - round_window 仍是「段（segment）」的物理表，表名不动；
--   - schedule_snapshot 仍是窗口粒度的历史档案，旧窗口接口继续读写它；
--   - schedule_revision 是赛季粒度的版本，和 schedule_snapshot 互不影响。
--
-- revision 1（线上旧排期）的灌入放在 worker/lib/kickoffSeason.ts 的归档函数里，
-- 由管理端一次性调用（POST /api/admin/seasons/:id/schedule/archive）。原因：
-- hash 要和旧接口 hashProposal 一样用 SHA-256，而 SQLite/D1 没有 sha256()；
-- 在迁移里塞一个假 hash 会让后续版本比对失真。归档函数幂等，重复调用不会覆盖。

CREATE TABLE IF NOT EXISTS schedule_revision (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id    INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  -- 对「场次 → 周/天/时刻」规范串的 SHA-256（与旧窗口 commit 的 proposalHash 同口径）
  hash         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','committed','published','restored')),
  -- 非空 = 该版本已公布/锁定；S3 的 publish 写这里
  locked_at    TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- 归档时的体检摘要（段数、场次数、hard/soft 冲突数、未归段场次），JSON
  metrics_json TEXT,
  note         TEXT,
  UNIQUE (season_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_schedule_revision_status
  ON schedule_revision(season_id, status, revision DESC);

-- 版本里的每一场。season_id 冗余存一份，方便按赛季直接查/对账；
-- segment_id 指向 round_window（段），窗口删了就把段置空，但场次与时刻仍保留在版本里。
-- match 不设 FK：赛事/阶段重建会删 match，但版本是历史事实，不能跟着 cascade 掉；
-- 回滚时若版本里的场次已不存在，restore 会返回 revision_incomplete 而不是悄悄少恢复。
CREATE TABLE IF NOT EXISTS schedule_revision_assignment (
  revision_id INTEGER NOT NULL REFERENCES schedule_revision(id) ON DELETE CASCADE,
  season_id   INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  segment_id  INTEGER REFERENCES round_window(id) ON DELETE SET NULL,
  match_id    INTEGER NOT NULL,
  -- match.id 不是 AUTOINCREMENT，赛事/阶段重建后可能复用；版本里额外存一份
  -- 稳定身份键（stage/round/slot/leg/home/away），restore 时对不上就拒绝回滚。
  match_key   TEXT NOT NULL,
  week        INTEGER NOT NULL CHECK (week >= 1),
  day         INTEGER NOT NULL CHECK (day BETWEEN 1 AND 7),
  time        TEXT NOT NULL,
  -- 1 = 越窗补赛（旧接口 PATCH 单场改期留下的标记），归档时原样保留
  override    INTEGER NOT NULL DEFAULT 0 CHECK (override IN (0,1)),
  reason      TEXT,
  PRIMARY KEY (revision_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_revision_assignment_season
  ON schedule_revision_assignment(season_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_schedule_revision_assignment_match
  ON schedule_revision_assignment(match_id);

-- 赛季级规则：season 级默认（competition='all'），competition 可覆盖。
-- 代码里的优先级：slot_override > competition 覆盖 > season_rule > 内置默认值。
CREATE TABLE IF NOT EXISTS season_rule (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id               INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  competition             TEXT NOT NULL DEFAULT 'all'
                          CHECK (competition IN ('all','top','sub','cup')),
  min_gap_hours           INTEGER NOT NULL DEFAULT 48 CHECK (min_gap_hours > 0),
  soft_gap_hours          INTEGER NOT NULL DEFAULT 64,
  report_gap_hours        INTEGER NOT NULL DEFAULT 72,
  -- 两连主（上一场主场、本场也主场）允许只按 min_gap_hours
  consecutive_home_exempt INTEGER NOT NULL DEFAULT 1
                          CHECK (consecutive_home_exempt IN (0,1)),
  -- 末轮同开：同一赛事/stream 的最大轮次压到同一天同一时刻
  last_round_simultaneous INTEGER NOT NULL DEFAULT 1
                          CHECK (last_round_simultaneous IN (0,1)),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by              TEXT,
  UNIQUE (season_id, competition),
  CHECK (soft_gap_hours >= min_gap_hours),
  CHECK (report_gap_hours >= soft_gap_hours)
);

-- 已有赛季补一条默认规则；新赛季由代码按内置默认值兜底，不依赖这行存在。
INSERT OR IGNORE INTO season_rule (season_id, competition)
SELECT id, 'all' FROM season;
