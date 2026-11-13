-- 0036：schedule_job —— 双循环自动生成的异步任务表（设计 §6）。
-- 设计见 docs/superpowers/specs/2026-11-12-asymmetric-double-round-robin-design.md。
--
-- 不建外键：阶段删除后任务行留作日志，查询时校验 tournament_id/stage_id 归属。
-- idx_schedule_job_active 是并发兜底：同一阶段同时只允许一个 pending/running 任务。
-- created_at 由代码写入（ISO 字符串，与库内其余 created_at 同风格），不设默认值。

CREATE TABLE IF NOT EXISTS schedule_job (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  stage_id      INTEGER NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'generate_double', -- 当前只有 generate_double
  mode          TEXT    NOT NULL,              -- mirror / asymmetric
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending / running / done / failed
  seed          INTEGER NOT NULL,
  budget_ms     INTEGER NOT NULL,
  result_json   TEXT,
  error         TEXT,
  created_by    INTEGER,
  created_at    TEXT    NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_job_active
  ON schedule_job(stage_id) WHERE status IN ('pending','running');

CREATE INDEX IF NOT EXISTS idx_schedule_job_stage
  ON schedule_job(stage_id, id DESC);
