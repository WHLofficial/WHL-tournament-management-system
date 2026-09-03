-- 比赛事件扩展：8 类 + 助攻球员。match_event.type 原有 CHECK 约束，SQLite 无法直接改，重建表。
CREATE TABLE match_event_new (
  id               INTEGER PRIMARY KEY,
  match_id         INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  entry_id         INTEGER NOT NULL REFERENCES entry(id),
  player_id        INTEGER REFERENCES player(id),
  assist_player_id INTEGER REFERENCES player(id),   -- 助攻球员（仅进球类事件，同队且非射手）
  type             TEXT NOT NULL CHECK (type IN (
    'goal', 'pen_goal', 'pen_miss', 'own_goal',
    'injury_minor', 'injury_major', 'yellow', 'red'
  )),
  minute     INTEGER,
  created_by INTEGER NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO match_event_new (id, match_id, entry_id, player_id, assist_player_id, type, minute, created_by, created_at)
  SELECT id, match_id, entry_id, player_id, NULL, type, minute, created_by, created_at FROM match_event;
DROP TABLE match_event;
ALTER TABLE match_event_new RENAME TO match_event;
CREATE INDEX idx_match_event_match ON match_event(match_id);
