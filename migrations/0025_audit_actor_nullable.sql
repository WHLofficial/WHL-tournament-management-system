-- #25 审计留痕放开 actor：机器间端点（v5.2.0 的 team-rename）没有本仓用户身份，
-- 审计要记 actor_user_id = NULL。0001 建表时写的是 NOT NULL（当时只有人类操作），
-- 且全仓没有可借的系统用户哨兵（club 侧 v6.3.2 同样规定机器 actor 一律 NULL）。
-- SQLite 不能 ALTER 掉 NOT NULL，只能按官方口径重建表：建新表 → 复制全量行 → 换名，
-- 最后补回 0018 建过的两条索引（DROP TABLE 会连索引一起带走）。
CREATE TABLE audit_log_new (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES user(id),
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     INTEGER,
  detail_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO audit_log_new (id, actor_user_id, action, target_type, target_id, detail_json, created_at)
  SELECT id, actor_user_id, action, target_type, target_id, detail_json, created_at FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id, id);
CREATE INDEX idx_audit_log_action ON audit_log(action, id);
