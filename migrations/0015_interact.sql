-- #13 头版门户互动层：全场最佳（MOTM）投票 + 快讯表态（emoji 反应）。
-- MOTM：一人一场一票（UNIQUE），改票 = 覆盖更新；观众号/教练/管理员同权。
-- 表态：快讯条目 × emoji 计数表，匿名去重靠前端 localStorage（服务端不做账号绑定，只无脑累加）；
--       emoji 存文本键（fire/thumb/mind/cry），前端映射 🔥👍🤯😢。
CREATE TABLE motm_vote (
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES match(id),
  user_id     INTEGER NOT NULL REFERENCES user(id),
  player_id   INTEGER NOT NULL REFERENCES player(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_motm_match_user ON motm_vote(match_id, user_id);
CREATE INDEX idx_motm_match ON motm_vote(match_id);

CREATE TABLE reaction (
  id          INTEGER PRIMARY KEY,
  item_id     TEXT NOT NULL,
  emoji       TEXT NOT NULL CHECK (emoji IN ('fire', 'thumb', 'mind', 'cry')),
  cnt         INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_reaction_item_emoji ON reaction(item_id, emoji);
