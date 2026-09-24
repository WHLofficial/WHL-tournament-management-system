// 增量 38 步骤 11：把「省读」的成果钉成可执行的回归断言。
// 量化方法、读数与判据见 scripts/d1-read-audit/README.md 与 TECH_DESIGN.md §3.1。
//
// 这里断言的是**执行计划**而不是行读量——行读量要打生产库才能量，不适合进单测；
// 而「规划器挑哪条索引」是行读量的直接成因，且在内存库上可复现。
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, sqlAll } from "./d1";
import { FINISHED_COLS, FINISHED_FROM_ROUND } from "../worker/lib/context";
import { TEAM_MISS_CANDIDATES_SQL } from "../worker/lib/injury";
import { COACH_DEFAULT_TOURNAMENT_SQL, COACH_ME_MATCHES_SQL } from "../worker/routes/coach";
import { filterRecapByCutoff } from "../worker/lib/feedNews";

// EXPLAIN QUERY PLAN 不绑参数也能跑，把每个计划步骤的 detail 拼成一行方便断言
function planOf(sqlite: DatabaseSync, sql: string): string {
  return sqlAll<{ detail: string }>(sqlite, `EXPLAIN QUERY PLAN ${sql}`)
    .map((r) => r.detail)
    .join(" | ");
}

const ROUND_FINISHED_SQL = `${FINISHED_COLS} ${FINISHED_FROM_ROUND}
       WHERE m.stage_id = ? AND m.round = ? AND m.status = 'finished'
       ORDER BY m.finished_at ASC, m.id ASC`;

// recapP 的轮次筛选子查询（worker/lib/feedNews.ts 的 recapP）
const RECAP_FILTER_SQL = `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at,
         s.tournament_id, t.name AS tournament_name, s.kind AS stage_kind, s.name AS stage_name
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       WHERE t.status != 'draft' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
         AND COALESCE(m.note, '') != '轮空'
         AND (m.stage_id, m.round) IN (SELECT stage_id, round FROM match WHERE status = 'finished')
       GROUP BY m.stage_id, m.round
       HAVING COUNT(*) = SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END)
         AND MAX(m.finished_at) < COALESCE(?, '9999-12-31')
       ORDER BY last_at DESC, stage_id DESC, round DESC LIMIT 20`;

// 反回归样本：参赛队 + 队内人数的**相关子查询**形式。
// 这三处（worker/routes/public.ts:99、worker/routes/admin/teams.ts:14、
// worker/routes/admin/tournaments.ts:180）刻意不改成「player 全表分组后 LEFT JOIN」——
// 实测那条改写赛事页 +68%、管理端 +12%（scripts/d1-read-audit/rewrite-ab.json）。
// 断言它仍走 idx_player_team 覆盖索引点查、不出现 player 全表扫。
const ENTRY_PLAYER_COUNT_SQL = `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted,
         tm.name AS team_name,
         (SELECT COUNT(*) FROM player p WHERE p.team_id = e.team_id) AS player_count
       FROM entry e
       JOIN team tm ON tm.id = e.team_id
       WHERE e.tournament_id = ?
       ORDER BY e.seed, e.id`;

describe("增量 38：D1 读消耗——关键查询的执行计划回归", () => {
  const { sqlite } = createTestDb();

  it("索引仍在：idx_match_stage / idx_match_status / idx_match_home / idx_match_away", () => {
    // INDEXED BY 是硬指令——索引被删则线上查询直接报错，所以先把索引存在性钉住
    const names = sqlAll<{ name: string }>(
      sqlite,
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).map((r) => r.name);
    for (const n of ["idx_match_stage", "idx_match_status", "idx_match_home", "idx_match_away"]) {
      expect(names, `索引 ${n} 缺失`).toContain(n);
    }
  });

  it("某轮完赛场走 idx_match_stage，不再被规划器改到 idx_match_status 上", () => {
    // 原状：规划器挑 idx_match_status（反向扫正好满足 ORDER BY finished_at DESC、省排序），
    // 代价是每轮只 4-10 场也要先扫全部完赛场（实测 11 轮合计 1081 → 393 行）。
    const plan = planOf(sqlite, ROUND_FINISHED_SQL);
    expect(plan).toContain("idx_match_stage");
    expect(plan).not.toContain("idx_match_status");
  });

  it("伤停候选：OR 作用在 match 自身列上，走 MULTI-INDEX OR，不出现 match 全表扫", () => {
    // 原状 `e1.team_id = ? OR e2.team_id = ?` 作用在 JOIN 出来的列上 ⇒ 无索引可用，
    // 全表 218 场 × 每张 join 表（实测 1342 → 156 行）。
    const plan = planOf(sqlite, TEAM_MISS_CANDIDATES_SQL);
    expect(plan).toContain("MULTI-INDEX OR");
    expect(plan).toContain("idx_match_home");
    expect(plan).toContain("idx_match_away");
    expect(plan).not.toMatch(/SCAN m\b/);
  });

  it("教练端两条同款 OR 改写：默认赛事与本队待赛场次都不再全表扫 match", () => {
    // 原状 OR 作用在 LEFT JOIN 出来的 he/ae 列上 ⇒ 规划器无法用 match 上的任何索引，
    // 退化为全表扫（LIMIT 1 读 755 行、本队待赛读 785 行）。改写后走 idx_match_status
    // 上的 status='pending' 窄过滤 + 两个 entry 子查询的覆盖索引点查（185 / 235 行）。
    for (const sql of [COACH_DEFAULT_TOURNAMENT_SQL, COACH_ME_MATCHES_SQL]) {
      const plan = planOf(sqlite, sql);
      expect(plan).not.toMatch(/SCAN m\b/);
      expect(plan).toMatch(/idx_match_status|MULTI-INDEX OR/);
      expect(plan).toContain("idx_entry_team");
    }
  });

  it("轮次综述筛选：加「有完赛场次的轮」子查询后不再全索引扫 match", () => {
    // 原状 GROUP BY 后由 HAVING 判断整轮是否完赛，规划器走 idx_match_stage 全索引扫（665 → 407 行）。
    const plan = planOf(sqlite, RECAP_FILTER_SQL);
    expect(plan).not.toMatch(/SCAN m\b/);
  });

  it("反回归：参赛队 + 队内人数仍走覆盖索引点查，不出现 player 全表扫", () => {
    // 见文件头注释：这条刻意不改成「分组物化后 join」，那条改写实测更贵。
    const plan = planOf(sqlite, ENTRY_PLAYER_COUNT_SQL);
    expect(plan).toContain("idx_player_team");
    expect(plan).not.toMatch(/SCAN p\b/);
    expect(plan).not.toMatch(/SCAN player\b/);
  });
});

describe("增量 38：综述按 cap 截断（纯函数，输出等价）", () => {
  type Row = { stage_id: number; round: number; last_at: string | null };
  const row = (stage_id: number, round: number, last_at: string | null): Row => ({
    stage_id,
    round,
    last_at,
  });
  // buildFeed 的最终输出是 sort(at desc).slice(0, cap)，窗口已提供 max(cap*3,40) 条带 at 的条目
  // ⇒ 任何 at 早于第 cap 条窗口项的条目不可能进入最终榜。判据用 >= 保守（等于则保留）。
  const window = [
    { finishedAt: "2026-09-20T00:00:00.000Z" },
    { finishedAt: "2026-09-15T00:00:00.000Z" },
    { finishedAt: "2026-09-10T00:00:00.000Z" },
  ] as never[];

  it("截掉 last_at 早于 cutoff 的轮", () => {
    const rows = [
      row(1, 5, "2026-09-18T00:00:00.000Z"),
      row(2, 4, "2026-09-12T00:00:00.000Z"),
      row(3, 3, "2026-09-01T00:00:00.000Z"),
    ];
    expect(filterRecapByCutoff(rows, window, 2).map((r) => r.stage_id)).toEqual([1]);
  });

  it("恰好等于 cutoff 的轮保留（保守判据，宁可多算）", () => {
    const rows = [row(1, 5, "2026-09-15T00:00:00.000Z"), row(2, 4, "2026-09-14T23:59:59.999Z")];
    expect(filterRecapByCutoff(rows, window, 2).map((r) => r.stage_id)).toEqual([1]);
  });

  it("last_at 为 null 的轮不截（拿不到时间就不敢丢）", () => {
    const rows = [row(1, 5, null)];
    expect(filterRecapByCutoff(rows, window, 2)).toHaveLength(1);
  });

  it("窗口不足 cap 条时原样返回（无 cutoff 可用）", () => {
    const rows = [row(1, 5, "2000-01-01T00:00:00.000Z")];
    expect(filterRecapByCutoff(rows, [window[0]] as never[], 5)).toEqual(rows);
  });

  it("空窗口原样返回", () => {
    const rows = [row(1, 5, "2000-01-01T00:00:00.000Z")];
    expect(filterRecapByCutoff(rows, [], 2)).toEqual(rows);
  });
});
