-- #13 头版门户：置顶公告（「一鱼两吃」的官方通报层）。
-- 同一时刻至多一条 active=1：发布新公告时由端点在同一 batch 内下线旧条；
-- 历史永久保留（active=0），可复激活，不物理删除。
CREATE TABLE announcement (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by  INTEGER NOT NULL REFERENCES user(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_announcement_active ON announcement(active);
