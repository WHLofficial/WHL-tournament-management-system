-- #13 战术存档（含人员）：tactic 表加 roster_json，存战术页的人员分配映射
-- {"首发lid": "player_id", ..., "b0".."b8": "player_id"}（键为 localStorage names 的原样键）
ALTER TABLE tactic ADD COLUMN roster_json TEXT NOT NULL DEFAULT '';
