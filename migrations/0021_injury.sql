-- 伤病扩展：伤停登记（必须挂一次伤病事件）+ 手动勾选缺阵比赛（可跨赛事、可补录已开赛/已完赛）
-- 「伤停中 / 伤愈进度」均为查询时派生（JOIN match.status 统计），不落状态列；
-- 删伤病事件 → 登记随事件消失（误录语义）；删球员/球队/比赛 → 级联清理。
CREATE TABLE injury (
  id          INTEGER PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  event_id    INTEGER NOT NULL REFERENCES match_event(id) ON DELETE CASCADE,
  injury_name TEXT,                              -- 伤病名库条目名；空 = 未选
  note        TEXT,
  created_by  INTEGER REFERENCES user(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_injury_team ON injury(team_id);
CREATE INDEX idx_injury_player ON injury(player_id);
CREATE INDEX idx_injury_event ON injury(event_id);

CREATE TABLE injury_miss (
  id         INTEGER PRIMARY KEY,
  injury_id  INTEGER NOT NULL REFERENCES injury(id) ON DELETE CASCADE,
  match_id   INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (injury_id, match_id)
);
CREATE INDEX idx_injury_miss_match ON injury_miss(match_id);
