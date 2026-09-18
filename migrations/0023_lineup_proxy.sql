-- 阵容代打：管理员把「提交某队某场阵容」的权限临时授给另一个账号，粒度精确到单场。
-- 有效性 = revoked_at IS NULL AND match.status = 'pending'——开赛即天然失效，所以不设 expires_at。

CREATE TABLE lineup_proxy_grant (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  grantee_user_id INTEGER NOT NULL,
  granted_by INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (match_id, team_id, grantee_user_id)
);

CREATE INDEX idx_lpg_grantee ON lineup_proxy_grant (grantee_user_id, match_id);
CREATE INDEX idx_lpg_match ON lineup_proxy_grant (match_id, team_id);

-- 留痕：这份阵容是哪条代打授权提交的，NULL = 本队教练自己交的。
-- 不加 REFERENCES：它是留痕指针不是活关系，加了外键会在删比赛/删球队时反过来卡住删除。
ALTER TABLE tactic_submission ADD COLUMN proxy_grant_id INTEGER;
