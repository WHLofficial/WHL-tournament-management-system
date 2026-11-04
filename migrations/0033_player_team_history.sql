-- 0033：球员归属履历表（阶段 A）。
-- 背景：player.team_id 同时承载「身份」和「归属」，解约球员因 match_event 外键删不掉，
-- 于是一直挂在原队名单里。归属拆到时间区间表后：解约=关窗、转会=关旧窗+开新窗，
-- 名册同步不再需要 DELETE，历史事件引用原样保留。
-- 阶段 A 保留 player.team_id 并双写（回滚保险），0035 才删列。

CREATE TABLE IF NOT EXISTS player_team_history (
  id         INTEGER PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL,
  left_at    TEXT,                          -- NULL = 至今仍在该队
  source     TEXT NOT NULL DEFAULT 'sync'
             CHECK (source IN ('transfer', 'fallback', 'sync', 'seed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 回填标记：NULL = 该球员履历还没用俱乐部转会记录回填过（归档前置检查依赖它）
ALTER TABLE player ADD COLUMN history_synced_at TEXT;

-- 一人至多一条开放窗口（D1 远程已确认支持 partial unique index）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pth_open_player
  ON player_team_history(player_id) WHERE left_at IS NULL;

-- 现役名单主查询：WHERE team_id = ? AND left_at IS NULL
CREATE INDEX IF NOT EXISTS idx_pth_open_team
  ON player_team_history(team_id) WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pth_player ON player_team_history(player_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_pth_team ON player_team_history(team_id);

-- 种子：读端上线即依赖开放窗口，不种子会让全站名单空到回填完成（约 13 小时）。
-- joined_at 取 player.created_at 作为下界，比迁移时刻更不容易漏掉归档时间窗；
-- 真实时间由后续履历回填覆盖。种子行不写 history_synced_at（保持 NULL）。
INSERT INTO player_team_history (player_id, team_id, joined_at, source)
SELECT id, team_id, created_at, 'seed' FROM player;
