-- 放开 tournament.format 的 CHECK：加 'custom'（空白编排，结构由管理员在编排页自建）。
-- SQLite 不能改 CHECK，只能整表重建。stage/entry 对 tournament 是 ON DELETE CASCADE，
-- DROP 时的隐式删除会级联清空全部下游数据——所以先把六张子表快照，重建后原样灌回。
PRAGMA defer_foreign_keys = true;
CREATE TABLE tournament_new (
  id          INTEGER PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organization(id),
  name        TEXT NOT NULL,
  description TEXT,
  format      TEXT NOT NULL
              CHECK (format IN ('single_elim', 'round_robin', 'group_knockout', 'custom')),
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'registering', 'running', 'archived')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by  INTEGER NOT NULL REFERENCES user(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO tournament_new (id, org_id, name, description, format, status, config_json, created_by, created_at)
  SELECT id, org_id, name, description, format, status, config_json, created_by, created_at FROM tournament;
CREATE TABLE stage_bak AS SELECT * FROM stage;
CREATE TABLE entry_bak AS SELECT * FROM entry;
CREATE TABLE group_bak AS SELECT * FROM "group";
CREATE TABLE match_bak AS SELECT * FROM match;
CREATE TABLE standing_bak AS SELECT * FROM standing;
CREATE TABLE match_event_bak AS SELECT * FROM match_event;
DROP TABLE tournament;
ALTER TABLE tournament_new RENAME TO tournament;
INSERT INTO stage SELECT * FROM stage_bak;
INSERT INTO entry SELECT * FROM entry_bak;
INSERT INTO "group" SELECT * FROM group_bak;
INSERT INTO match SELECT * FROM match_bak;
INSERT INTO standing SELECT * FROM standing_bak;
INSERT INTO match_event SELECT * FROM match_event_bak;
DROP TABLE stage_bak; DROP TABLE entry_bak; DROP TABLE group_bak;
DROP TABLE match_bak; DROP TABLE standing_bak; DROP TABLE match_event_bak;
CREATE INDEX idx_tournament_org ON tournament(org_id);
