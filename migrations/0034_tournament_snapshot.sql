-- 0034：赛事归档快照（payload v2）。
-- 归档后赛事退出实时维护：球员可能继续转会、球队可能改名，榜单不能再按「现在属于哪队」算。
-- 归档瞬间把「这届赛事里出现过的球员待过哪些参赛队」冻结下来，归档页只读这份快照。
CREATE TABLE IF NOT EXISTS tournament_snapshot (
  tournament_id INTEGER PRIMARY KEY REFERENCES tournament(id) ON DELETE CASCADE,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
