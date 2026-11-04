-- 0032：排期快照改成「窗口粒度」。
-- 0031 建表时按 stage/round/leg 记录，但次级联赛的季后赛横跨 stage 3（冲刺组）和
-- stage 4（挑战组），一个窗口无法落到单个 stage 上；直接以 round_window.id 为主键锚点。
-- 该表此前从未写入，删表重建没有数据损失。
DROP TABLE IF EXISTS schedule_snapshot;

CREATE TABLE schedule_snapshot (
  id         INTEGER PRIMARY KEY,
  window_id  INTEGER NOT NULL REFERENCES round_window(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_snapshot_window
  ON schedule_snapshot(window_id);
