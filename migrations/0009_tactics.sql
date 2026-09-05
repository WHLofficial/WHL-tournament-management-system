-- #13 战术板：战术存档与「在线提交战术阵容」远期预留表（本期只建表，不加读写端点）
-- tactic：教练的战术码存档模板；tactic_submission：某场比赛某队提交的战术阵容（slots_json 20 条）
CREATE TABLE tactic (
  id          INTEGER PRIMARY KEY,
  team_id     INTEGER REFERENCES team(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES user(id),
  code        TEXT NOT NULL,                  -- 11/12 位战术码
  form        TEXT NOT NULL,                  -- 阵型值，如 433
  buildup     TEXT NOT NULL,                  -- balanced|counter|shortpassing
  line_height INTEGER NOT NULL,               -- 防线高度 1–100
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tactic_team ON tactic(team_id);

CREATE TABLE tactic_submission (
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES user(id),
  tactic_id   INTEGER REFERENCES tactic(id) ON DELETE SET NULL,  -- 可空：现排不存档
  slots_json  TEXT NOT NULL,                  -- 11 首发 {lid,position,player_id} + 9 替补 {kind:'bench',player_id}
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (match_id, team_id)                  -- 一赛一队一份，重复提交覆盖
);
CREATE INDEX idx_tsub_match ON tactic_submission(match_id, team_id);
