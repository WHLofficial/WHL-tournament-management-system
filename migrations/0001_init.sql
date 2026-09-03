-- WHL 赛事管理系统 初始 schema（ER 见 TECH_DESIGN.md §3）
-- 时间一律存 ISO-8601 文本（UTC）。

CREATE TABLE organization (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- P0 单组织；多组织是 P2 扩展位
INSERT INTO organization (id, name) VALUES (1, 'WHL');

CREATE TABLE user (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,           -- 昵称即登录名
  email         TEXT,                           -- 可选、不验证
  password_hash TEXT NOT NULL,                  -- pbkdf2$iter$salt_b64$hash_b64
  role          TEXT NOT NULL DEFAULT 'coach'
                CHECK (role IN ('coach', 'admin', 'superadmin')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 外部身份可插拔位（P0 不做功能）
CREATE TABLE identity (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, provider_uid)
);

-- 注册码：批量、一次/多次有效、可限时；明码只在生成响应出现一次
CREATE TABLE signup_code (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,              -- sha256 hex
  expires_at TEXT,
  max_uses   INTEGER,                           -- NULL = 不限次
  used_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE team (
  id         INTEGER PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES organization(id),
  name       TEXT NOT NULL,
  created_by INTEGER REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, name)
);

CREATE TABLE player (
  id         INTEGER PRIMARY KEY,
  team_id    INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  number     TEXT,                              -- 号码，允许空
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_player_team ON player(team_id);

-- 认证码绑队（一账号一队 → UNIQUE(user_id)；一队多人可绑）
CREATE TABLE team_member (
  id         INTEGER PRIMARY KEY,
  team_id    INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (team_id, user_id),
  UNIQUE (user_id)
);

-- 队伍认证码：8 位、一次有效、可限时默认 24h
CREATE TABLE auth_code (
  id         INTEGER PRIMARY KEY,
  team_id    INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TEXT,
  used_by    INTEGER REFERENCES user(id),
  used_at    TEXT,
  created_by INTEGER NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_auth_code_team ON auth_code(team_id);

-- tournament.format 只是建赛预设，实际结构 = 有序 stage 列表
CREATE TABLE tournament (
  id          INTEGER PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organization(id),
  name        TEXT NOT NULL,
  description TEXT,
  format      TEXT NOT NULL
              CHECK (format IN ('single_elim', 'round_robin', 'group_knockout')),
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'registering', 'running', 'archived')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by  INTEGER NOT NULL REFERENCES user(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tournament_org ON tournament(org_id);

CREATE TABLE stage (
  id            INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('elim', 'round_robin', 'group')),
  sort_order    INTEGER NOT NULL,
  config_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_stage_tournament ON stage(tournament_id);

CREATE TABLE "group" (
  id         INTEGER PRIMARY KEY,
  stage_id   INTEGER NOT NULL REFERENCES stage(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE entry (
  id            INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES team(id),
  seed          INTEGER NOT NULL,               -- 录入顺序，可打乱
  group_id      INTEGER REFERENCES "group"(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tournament_id, team_id)
);
CREATE INDEX idx_entry_tournament ON entry(tournament_id);

CREATE TABLE match (
  id             INTEGER PRIMARY KEY,
  stage_id       INTEGER NOT NULL REFERENCES stage(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  slot           INTEGER NOT NULL,
  leg            INTEGER,                       -- legs=2 时 1|2
  home_entry_id  INTEGER REFERENCES entry(id),
  away_entry_id  INTEGER REFERENCES entry(id),
  score_home     INTEGER,
  score_away     INTEGER,
  pen_home       INTEGER,                       -- 点球比分（决胜用）
  pen_away       INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'live', 'finished')),
  winner_entry_id INTEGER REFERENCES entry(id),
  note           TEXT,                          -- 弃权判负等备注
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_match_stage ON match(stage_id, round, slot);
CREATE INDEX idx_match_home ON match(home_entry_id);
CREATE INDEX idx_match_away ON match(away_entry_id);

-- 全量重算的产物；归档时另存快照（P1 加 snapshot 表）
CREATE TABLE standing (
  id       INTEGER PRIMARY KEY,
  stage_id INTEGER NOT NULL REFERENCES stage(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES "group"(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  played   INTEGER NOT NULL DEFAULT 0,
  won      INTEGER NOT NULL DEFAULT 0,
  drawn    INTEGER NOT NULL DEFAULT 0,
  lost     INTEGER NOT NULL DEFAULT 0,
  pts      INTEGER NOT NULL DEFAULT 0,
  gf       INTEGER NOT NULL DEFAULT 0,
  ga       INTEGER NOT NULL DEFAULT 0,
  pen_won  INTEGER NOT NULL DEFAULT 0,
  pen_lost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (stage_id, entry_id)
);
CREATE INDEX idx_standing_stage ON standing(stage_id);

-- 进球/红黄牌事件；live 比分由 goal 事件累计，终场确认才落 score
CREATE TABLE match_event (
  id         INTEGER PRIMARY KEY,
  match_id   INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  entry_id   INTEGER NOT NULL REFERENCES entry(id),
  player_id  INTEGER REFERENCES player(id),
  type       TEXT NOT NULL CHECK (type IN ('goal', 'yellow', 'red')),
  minute     INTEGER,
  created_by INTEGER NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_match_event_match ON match_event(match_id);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES user(id),
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     INTEGER,
  detail_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
