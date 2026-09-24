/**
 * 形状实测（增量 38 步骤 2）
 *
 * 分三段：
 *  A. 生产索引清单（sqlite_master）——判断「贵形状」是缺索引还是本来就该扫
 *  B. 对最贵形状跑 EXPLAIN QUERY PLAN（参数内联后打生产）——看清走的是索引还是全表
 *  C. 候选改写 A/B 对照——现状形状 vs 拟改形状，各量 rows_read，用读数而不是直觉决定
 *
 * 用法：
 *   npx vite-node scripts/d1-read-audit/measure-shapes.mts            # 全跑
 *   npx vite-node scripts/d1-read-audit/measure-shapes.mts --plan-only  # 只跑 A+B（不花行读）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { explainPlan, inlineParams, queryRows, queryMeta, runWrangler, oneLine } from "./harness.mts";

const planOnly = process.argv.includes("--plan-only");
const cOnly = process.argv.includes("--c-only");
const ranking = JSON.parse(readFileSync("scripts/d1-read-audit/shape-ranking.json", "utf8")) as {
  shapes: Array<{ sql: string; table: string; rows_read: number; calls: number; surfaces: string[] }>;
};

console.log("═══ A. 生产索引清单 ═══");
const idx = queryRows(
  "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name",
);
const byTable = new Map<string, string[]>();
for (const r of idx) {
  const t = String(r.tbl_name);
  const cols = /\(([^)]*)\)\s*$/.exec(String(r.sql))?.[1] ?? "?";
  byTable.set(t, [...(byTable.get(t) ?? []), `${String(r.name).replace(/^idx_/, "")}(${cols.replace(/\s+/g, " ")})`]);
}
for (const [t, list] of [...byTable.entries()].sort()) console.log(`  ${t.padEnd(20)} ${list.join("  ")}`);
const indexed = new Set([...byTable.keys()]);

console.log("\n═══ B. 最贵形状的执行计划 ═══");
/** 用普查时记录的真实参数（假 D1 抓下来的），保证计划是线上同一形状。 */
const census = JSON.parse(readFileSync("scripts/d1-read-audit/surface-measurements.json", "utf8")) as {
  surfaces: Array<{ name: string; statements: Array<{ sql: string; args: unknown[]; rows_read: number }> }>;
};
const argsBySql = new Map<string, unknown[]>();
/** 形状榜里的 SQL 是折叠过空白的键，参数表也要用同一个键，否则查不到参数、`?` 没内联、
 *  D1 会因为「未绑定参数」直接拒掉 EXPLAIN。 */
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
for (const s of census.surfaces)
  for (const st of s.statements) if (!argsBySql.has(norm(st.sql))) argsBySql.set(norm(st.sql), st.args);

const top = ranking.shapes.slice(0, 14);
for (const [i, sh] of top.entries()) {
  const args = argsBySql.get(sh.sql) ?? [];
  // EXPLAIN 只关心计划，多行 SQL 折成一行能躲开 CLI 对换行的处理差异
  const sql = oneLine(args.length ? inlineParams(sh.sql, args) : sh.sql, 100000);
  let plan: string[];
  try {
    plan = explainPlan(sql);
  } catch (e) {
    plan = [`(EXPLAIN 失败) ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`];
  }
  const scans = plan.filter((p) => /SCAN /.test(p)).length;
  console.log(
    `\n${i + 1}. [${sh.table}] ${sh.rows_read} 行 ×${sh.calls}${indexed.has(sh.table) ? "" : "（该表无任何索引）"}${scans ? `  ⚠ ${scans} 处 SCAN` : ""}`,
  );
  console.log(`   ${oneLine(sh.sql, 170)}`);
  for (const p of plan) console.log(`     · ${p}`);
}

if (planOnly) {
  console.log("\n（--plan-only：跳过 C 段）");
  process.exit(0);
}

console.log("\n═══ C. 候选改写 A/B 对照 ═══");
/**
 * 每对：现状形状 vs 拟改形状。都打生产读 rows_read，并给出执行计划差异。
 * 判据不是「看着更快」，而是读数与 SCAN 数量是否真的变化。
 */
interface Pair {
  name: string;
  why: string;
  a: string;
  b: string;
}
const pairs: Pair[] = [
  {
    name: "伤停候选（最贵单形状 1326 行）",
    why: "admin/injury-candidates。A 用 JOIN 出的 team_id 做 OR 条件 ⇒ 无索引可用、全表 218 场 ×7 表；B 改成对 match 自身的 home/away_entry_id 用 IN 子查询（shape #16 的省法）",
    a: `SELECT m.id AS match_id, t2.id AS tournament_id, t2.name AS tournament_name, m.round, s.kind AS stage_kind, m.status, eh.id AS home_team_id, eh.name AS home_team_name, ea.id AS away_team_id, ea.name AS away_team_name FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t2 ON t2.id = s.tournament_id JOIN entry e1 ON e1.id = m.home_entry_id JOIN team eh ON eh.id = e1.team_id LEFT JOIN entry e2 ON e2.id = m.away_entry_id LEFT JOIN team ea ON ea.id = e2.team_id WHERE e1.team_id = 1 OR e2.team_id = 1 ORDER BY t2.id, s.sort_order, m.round, m.slot, m.leg, m.id`,
    b: `SELECT m.id AS match_id, t2.id AS tournament_id, t2.name AS tournament_name, m.round, s.kind AS stage_kind, m.status, eh.id AS home_team_id, eh.name AS home_team_name, ea.id AS away_team_id, ea.name AS away_team_name FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t2 ON t2.id = s.tournament_id LEFT JOIN entry e1 ON e1.id = m.home_entry_id LEFT JOIN team eh ON eh.id = e1.team_id LEFT JOIN entry e2 ON e2.id = m.away_entry_id LEFT JOIN team ea ON ea.id = e2.team_id WHERE m.home_entry_id IN (SELECT id FROM entry WHERE team_id = 1) OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = 1) ORDER BY t2.id, s.sort_order, m.round, m.slot, m.leg, m.id`,
  },
  {
    name: "待赛列表两段式（public/upcoming 1185 行，只回 8 行）",
    why: "A 七表 join 全部 149 场 pending 后才 LIMIT 8；B 先只取 id（三表），名字另取 8 行。B 的实际总成本 ≈ B + 8×4 行名字查询",
    a: `SELECT t.id AS tournament_id, t.name AS tournament_name, t.status AS tournament_status, m.id AS match_id, s.kind AS stage_kind, s.sort_order AS stage_order, m.round, ht.name AS home_team_name, at.name AS away_team_name FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id JOIN entry he ON he.id = m.home_entry_id JOIN team ht ON ht.id = he.team_id JOIN entry ae ON ae.id = m.away_entry_id JOIN team at ON at.id = ae.team_id WHERE t.status != 'draft' AND m.status = 'pending' AND (m.note IS NULL OR m.note != '轮空') ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.id, s.sort_order, m.round, m.slot LIMIT 8`,
    b: `SELECT m.id AS match_id, t.id AS tournament_id, t.status AS tournament_status, s.kind AS stage_kind, s.sort_order AS stage_order, m.round FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id WHERE t.status != 'draft' AND m.status = 'pending' AND (m.note IS NULL OR m.note != '轮空') ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.id, s.sort_order, m.round, m.slot LIMIT 8`,
  },
  {
    name: "赛事页待赛场次两段式（public/tournament-summary 805 行，只回 4 行）",
    why: "A 六表 join 该赛事全部 pending 后才 LIMIT 4；B 先只取 id（两表）",
    a: `SELECT m.id, m.stage_id, m.round, m.slot, m.leg, m.home_entry_id, m.away_entry_id, ht.name AS home_team_name, at.name AS away_team_name, ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key, m.score_home, m.score_away, m.pen_home, m.pen_away, m.status, m.winner_entry_id, m.note, m.walkover_side, s.kind AS stage_kind, s.name AS stage_name, s.sort_order AS stage_order FROM match m JOIN stage s ON s.id = m.stage_id LEFT JOIN entry he ON he.id = m.home_entry_id LEFT JOIN team ht ON ht.id = he.team_id LEFT JOIN entry ae ON ae.id = m.away_entry_id LEFT JOIN team at ON at.id = ae.team_id WHERE s.tournament_id = 1 AND m.status = 'pending' AND he.id IS NOT NULL AND ae.id IS NOT NULL ORDER BY s.sort_order, m.round, m.slot LIMIT 4`,
    b: `SELECT m.id, m.stage_id, m.round, m.slot, m.leg, m.home_entry_id, m.away_entry_id, s.kind AS stage_kind, s.name AS stage_name, s.sort_order AS stage_order FROM match m JOIN stage s ON s.id = m.stage_id WHERE s.tournament_id = 1 AND m.status = 'pending' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL ORDER BY s.sort_order, m.round, m.slot LIMIT 4`,
  },
  {
    name: "参赛队 + 队内人数（760 行 ×2 个读面）",
    why: "A 逐 entry 相关子查询数人数；B 改成 player 全表分组后 LEFT JOIN。赛事只 12 支队时谁更便宜，用读数定",
    a: `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted, tm.name AS team_name, tm.logo_key, (SELECT COUNT(*) FROM player p WHERE p.team_id = e.team_id) AS player_count FROM entry e JOIN team tm ON tm.id = e.team_id WHERE e.tournament_id = 1 ORDER BY e.seed`,
    b: `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted, tm.name AS team_name, tm.logo_key, COALESCE(x.n, 0) AS player_count FROM entry e JOIN team tm ON tm.id = e.team_id LEFT JOIN (SELECT team_id, COUNT(*) AS n FROM player GROUP BY team_id) x ON x.team_id = e.team_id WHERE e.tournament_id = 1 ORDER BY e.seed`,
  },
  {
    name: "各阶段最后完赛轮次（655 行，1 处 SCAN）",
    why: "A 现状 GROUP BY stage_id,round 走 idx_match_stage 全索引扫描；B 用 status='finished' 驱动 idx_match_status（B 少了赛事名 join，名字按 ≤20 行另取）",
    a: `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at, s.tournament_id, t.name AS tournament_name, s.kind AS stage_kind, s.name AS stage_name FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id WHERE t.status != 'draft' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL AND COALESCE(m.note, '') != '轮空' GROUP BY m.stage_id, m.round HAVING COUNT(*) = SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END) AND MAX(m.finished_at) < COALESCE('9999-12-31', '9999-12-31') ORDER BY last_at DESC, stage_id DESC, round DESC LIMIT 20`,
    b: `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at FROM match m WHERE m.status = 'finished' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL AND COALESCE(m.note, '') != '轮空' GROUP BY m.stage_id, m.round ORDER BY last_at DESC LIMIT 20`,
  },
  {
    name: "成本模型探针：同一张表、LIMIT 4，排序键决定代价",
    why: "验证「LIMIT 不是免费」：按索引序取 4 行 vs 按未索引列排序取 4 行",
    a: `SELECT id, finished_at FROM match WHERE status = 'finished' ORDER BY finished_at DESC LIMIT 4`,
    b: `SELECT id, finished_at FROM match WHERE status = 'finished' ORDER BY round DESC LIMIT 4`,
  },
  {
    name: "成本模型探针：JOIN 一张 48 行表并排序要多少读",
    why: "量清 injury_miss 展开 579 行的来源：纯扫描 48 行 vs 四表 join 后排序",
    a: `SELECT COUNT(*) AS n FROM injury_miss`,
    b: `SELECT im.injury_id, im.match_id, t2.id AS tournament_id, t2.name AS tournament_name, m.round, s.kind AS stage_kind, m.status FROM injury_miss im JOIN match m ON m.id = im.match_id JOIN stage s ON s.id = m.stage_id JOIN tournament t2 ON t2.id = s.tournament_id ORDER BY s.sort_order, m.round, m.slot, m.leg, m.id`,
  },
  {
    name: "成本模型探针：两段式第二段的真实价格（8 场比赛取队名）",
    why: "上面两条「两段式」候选都少了名字，这里量补名字到底要多少行：按主键取 8 场 × 4 表",
    a: `SELECT COUNT(*) AS n FROM match WHERE status = 'pending'`,
    b: `SELECT m.id, ht.name AS home_team_name, at.name AS away_team_name FROM match m JOIN entry he ON he.id = m.home_entry_id JOIN team ht ON ht.id = he.team_id JOIN entry ae ON ae.id = m.away_entry_id JOIN team at ON at.id = ae.team_id WHERE m.id IN (14, 21, 22, 23, 24, 25, 26, 27)`,
  },

  // ── 下面六组是步骤 5.3 补测：实施前先把读数拿到，不达预期就删掉该项 ──────────────
  {
    name: "教练状态默认赛事：OR 作用在 join 列上（coach/me/status，LIMIT 1 却扫全量）",
    why: "A `he.team_id = 1 OR ae.team_id = 1` 作用在 LEFT JOIN 出来的列上 ⇒ 无索引可用；B 改成对 match 自身的 home/away_entry_id 用 IN 子查询（同伤停候选的省法）。NULL 语义等价：away 为空时 NULL IN (...) 不为真",
    a: `SELECT t.id AS tournament_id FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id LEFT JOIN entry he ON he.id = m.home_entry_id LEFT JOIN entry ae ON ae.id = m.away_entry_id WHERE m.status = 'pending' AND t.status != 'draft' AND (m.note IS NULL OR m.note != '轮空') AND (he.team_id = 1 OR ae.team_id = 1) ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot LIMIT 1`,
    b: `SELECT t.id AS tournament_id FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id LEFT JOIN entry he ON he.id = m.home_entry_id LEFT JOIN entry ae ON ae.id = m.away_entry_id WHERE m.status = 'pending' AND t.status != 'draft' AND (m.note IS NULL OR m.note != '轮空') AND (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = 1) OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = 1)) ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot LIMIT 1`,
  },
  {
    name: "本队待赛场次：同款 OR 改写（coach/me/matches，含两个 LEFT JOIN 到本队的表）",
    why: "A 同上一组的 OR 模式，但这条还带 tactic_submission 与 lineup_proxy_grant 两个按本队过滤的 LEFT JOIN（列 sub_id/grant_id 还在用，必须保留）；B 只换 WHERE 里的 OR",
    a: `SELECT m.id, m.round, m.leg, m.note, t.id AS tournament_id, t.name AS tournament_name, s.name AS stage_name, s.kind AS stage_kind, he.team_id AS home_tid, ae.team_id AS away_tid, ht.name AS home_team_name, at.name AS away_team_name, ts.id AS sub_id, g.id AS grant_id FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id LEFT JOIN entry he ON he.id = m.home_entry_id LEFT JOIN entry ae ON ae.id = m.away_entry_id LEFT JOIN team ht ON ht.id = he.team_id LEFT JOIN team at ON at.id = ae.team_id LEFT JOIN tactic_submission ts ON ts.match_id = m.id AND ts.team_id = 1 LEFT JOIN lineup_proxy_grant g ON g.id = (SELECT MIN(g2.id) FROM lineup_proxy_grant g2 WHERE g2.match_id = m.id AND g2.team_id = 1 AND g2.revoked_at IS NULL) WHERE m.status = 'pending' AND t.status != 'draft' AND (m.note IS NULL OR m.note != '轮空') AND (he.team_id = 1 OR ae.team_id = 1) ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot`,
    b: `SELECT m.id, m.round, m.leg, m.note, t.id AS tournament_id, t.name AS tournament_name, s.name AS stage_name, s.kind AS stage_kind, he.team_id AS home_tid, ae.team_id AS away_tid, ht.name AS home_team_name, at.name AS away_team_name, ts.id AS sub_id, g.id AS grant_id FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id LEFT JOIN entry he ON he.id = m.home_entry_id LEFT JOIN entry ae ON ae.id = m.away_entry_id LEFT JOIN team ht ON ht.id = he.team_id LEFT JOIN team at ON at.id = ae.team_id LEFT JOIN tactic_submission ts ON ts.match_id = m.id AND ts.team_id = 1 LEFT JOIN lineup_proxy_grant g ON g.id = (SELECT MIN(g2.id) FROM lineup_proxy_grant g2 WHERE g2.match_id = m.id AND g2.team_id = 1 AND g2.revoked_at IS NULL) WHERE m.status = 'pending' AND t.status != 'draft' AND (m.note IS NULL OR m.note != '轮空') AND (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = 1) OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = 1)) ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot`,
  },
  {
    name: "轮次伤情：加 match_id 子查询能否改掉 type 驱动的扫描（feed 的 injuriesInRound）",
    why: "A 现状由 idx_match_event_type_time(type=?) 驱动 ⇒ 扫全部伤情事件（生产 28 条）；B 加 `me.match_id IN (SELECT ...)` 看规划器会不会改走 idx_match_event_match。注意这里必须用语义等价的子查询，不能由调用方传「已完赛场次 id」——buildRoundRecap 的轮次可能未完赛",
    a: `SELECT me.id AS event_id, i.id AS injury_id, me.player_id, p.name AS player_name, t.id AS team_id, t.name AS team_name, me.type, i.injury_name, m.id AS match_id, m.stage_id, m.round, m.finished_at, s.tournament_id, tt.name AS tournament_name, (SELECT COUNT(*) FROM injury_miss im JOIN match m2 ON m2.id = im.match_id WHERE im.injury_id = i.id AND m2.status != 'finished') AS out_matches FROM match_event me JOIN match m ON m.id = me.match_id JOIN stage s ON s.id = m.stage_id JOIN tournament tt ON tt.id = s.tournament_id JOIN entry e ON e.id = me.entry_id JOIN team t ON t.id = e.team_id JOIN player p ON p.id = me.player_id LEFT JOIN injury i ON i.event_id = me.id WHERE me.type IN ('injury_minor', 'injury_major') AND tt.status != 'draft' AND m.stage_id = 1 AND m.round = 5 ORDER BY m.finished_at, me.id`,
    b: `SELECT me.id AS event_id, i.id AS injury_id, me.player_id, p.name AS player_name, t.id AS team_id, t.name AS team_name, me.type, i.injury_name, m.id AS match_id, m.stage_id, m.round, m.finished_at, s.tournament_id, tt.name AS tournament_name, (SELECT COUNT(*) FROM injury_miss im JOIN match m2 ON m2.id = im.match_id WHERE im.injury_id = i.id AND m2.status != 'finished') AS out_matches FROM match_event me JOIN match m ON m.id = me.match_id JOIN stage s ON s.id = m.stage_id JOIN tournament tt ON tt.id = s.tournament_id JOIN entry e ON e.id = me.entry_id JOIN team t ON t.id = e.team_id JOIN player p ON p.id = me.player_id LEFT JOIN injury i ON i.event_id = me.id WHERE me.type IN ('injury_minor', 'injury_major') AND tt.status != 'draft' AND me.match_id IN (SELECT id FROM match WHERE stage_id = 1 AND round = 5) ORDER BY m.finished_at, me.id`,
  },
  {
    name: "待赛列表：两段式 vs 单语句子查询（省掉第二次往返）",
    why: "A 是上一组「两段式」的 B（只取 id，三表）；B 把 LIMIT 8 塞进子查询、外层再 join 队名 —— 行读若与 A 相当，就能省掉一次往返（PERF_PLAN 口径每次串行 D1 ≈ +0.2s）。若明显更贵就退回两段式",
    a: `SELECT m.id AS match_id, t.id AS tournament_id, t.status AS tournament_status, s.kind AS stage_kind, s.sort_order AS stage_order, m.round FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id WHERE t.status != 'draft' AND m.status = 'pending' AND (m.note IS NULL OR m.note != '轮空') ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.id, s.sort_order, m.round, m.slot LIMIT 8`,
    b: `SELECT t.id AS tournament_id, t.name AS tournament_name, t.status AS tournament_status, m.id AS match_id, s.kind AS stage_kind, s.sort_order AS stage_order, m.round, ht.name AS home_team_name, at.name AS away_team_name FROM (SELECT m.id, m.stage_id, m.round, m.slot, m.home_entry_id, m.away_entry_id FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id WHERE t.status != 'draft' AND m.status = 'pending' AND (m.note IS NULL OR m.note != '轮空') ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.id, s.sort_order, m.round, m.slot LIMIT 8) m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id JOIN entry he ON he.id = m.home_entry_id JOIN team ht ON ht.id = he.team_id JOIN entry ae ON ae.id = m.away_entry_id JOIN team at ON at.id = ae.team_id ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END, t.id, s.sort_order, m.round, m.slot`,
  },
  {
    name: "综述轮次筛选：等价地先限定「有完赛场次的轮」能不能改掉全索引扫描（feed 的 recapP）",
    why: "A 现状 GROUP BY stage_id,round 后由 HAVING 判断整轮是否完赛 ⇒ 规划器走 idx_match_stage 全索引扫（实测 655 行）。B 加 `(m.stage_id, m.round) IN (SELECT ... status='finished')` 缩小 GROUP BY 的输入，语义等价（一轮若没有任何完赛场次，COUNT(*) 必然 > SUM(finished)，HAVING 本就不成立）",
    a: `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at, s.tournament_id, t.name AS tournament_name, s.kind AS stage_kind, s.name AS stage_name FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id WHERE t.status != 'draft' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL AND COALESCE(m.note, '') != '轮空' GROUP BY m.stage_id, m.round HAVING COUNT(*) = SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END) AND MAX(m.finished_at) < COALESCE('9999-12-31', '9999-12-31') ORDER BY last_at DESC, stage_id DESC, round DESC LIMIT 20`,
    b: `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at, s.tournament_id, t.name AS tournament_name, s.kind AS stage_kind, s.name AS stage_name FROM match m JOIN stage s ON s.id = m.stage_id JOIN tournament t ON t.id = s.tournament_id WHERE t.status != 'draft' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL AND COALESCE(m.note, '') != '轮空' AND (m.stage_id, m.round) IN (SELECT stage_id, round FROM match WHERE status = 'finished') GROUP BY m.stage_id, m.round HAVING COUNT(*) = SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END) AND MAX(m.finished_at) < COALESCE('9999-12-31', '9999-12-31') ORDER BY last_at DESC, stage_id DESC, round DESC LIMIT 20`,
  },
  {
    name: "终场合并阶段扫描：现状是两条语句，这里量「一条全阶段读」值不值",
    why: "现状每次终场在相邻两处各扫一遍全阶段：buildStandingsStmts 读 status='finished'（实测 133 行）+ buildAutoFillStmts 读 COUNT(*) ... status!='finished'（实测 133 行）= 266。A 是后者（可被消掉的那条）；B 是一条读全阶段所有列的合并形状（buildAdvanceStmts 已是这个形状）。判据是 B 是否 < 133 + A",
    a: `SELECT COUNT(*) AS n FROM match WHERE stage_id = 1 AND status != 'finished'`,
    b: `SELECT id, round, slot, leg, home_entry_id, away_entry_id, score_home, score_away, pen_home, pen_away, status, winner_entry_id, note FROM match WHERE stage_id = 1 ORDER BY round, slot, leg`,
  },
];

const abOut: unknown[] = [];
const pairFilter = (process.argv.find((a) => a.startsWith("--pairs=")) ?? "").slice("--pairs=".length);
for (const p of pairs) {
  if (pairFilter && !p.name.includes(pairFilter)) continue;
  const ra = queryMeta(p.a);
  const rb = queryMeta(p.b);
  const pa = explainPlan(p.a);
  const pb = explainPlan(p.b);
  const scans = (x: string[]) => x.filter((l) => /SCAN /.test(l)).length;
  console.log(`\n· ${p.name} —— ${p.why}`);
  console.log(`  A 现状 ${String(ra.rows_read).padStart(6)} 行  SCAN×${scans(pa)}  ${oneLine(p.a, 110)}`);
  console.log(`  B 候选 ${String(rb.rows_read).padStart(6)} 行  SCAN×${scans(pb)}  ${oneLine(p.b, 110)}`);
  const delta = ra.rows_read === 0 ? 0 : ((rb.rows_read - ra.rows_read) / ra.rows_read) * 100;
  console.log(`  差 ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`);
  for (const l of pa) console.log(`    A· ${l}`);
  for (const l of pb) console.log(`    B· ${l}`);
  abOut.push({ name: p.name, why: p.why, a: p.a, b: p.b, a_rows_read: ra.rows_read, b_rows_read: rb.rows_read, a_plan: pa, b_plan: pb, delta_pct: Number(delta.toFixed(1)) });
}
// --pairs= 只跑选中的几组时按名字合并回既有结果，别把已量到的对拍冲掉
const abPath = "scripts/d1-read-audit/rewrite-ab.json";
let abFinal: unknown[] = abOut;
if (pairFilter) {
  try {
    const prev = JSON.parse(readFileSync(abPath, "utf8")) as { pairs: Array<{ name: string }> };
    const fresh = new Map((abOut as Array<{ name: string }>).map((x) => [x.name, x]));
    abFinal = prev.pairs.map((x) => fresh.get(x.name) ?? x);
    for (const x of abOut as Array<{ name: string }>) if (!prev.pairs.some((y) => y.name === x.name)) abFinal.push(x);
  } catch {
    /* 首次运行没有既有结果，直接用本次的 */
  }
}
writeFileSync(abPath, JSON.stringify({ measured_at: new Date().toISOString(), pairs: abFinal }, null, 2));
console.log("\n→ scripts/d1-read-audit/rewrite-ab.json");

// ── D. 成本模型阶梯：把「rows_read 到底在数什么」钉死 ──────────────────────────
if (cOnly) {
  console.log("\n（--c-only：跳过 D 段）");
  process.exit(0);
}
console.log("\n═══ D. 成本模型阶梯（--command 与 --file 双通道各量一遍）═══");
const ladder: Array<{ label: string; sql: string }> = [
  { label: "match 主键点查 8 行", sql: `SELECT id FROM match WHERE id IN (14,21,22,23,24,25,26,27)` },
  { label: "match 索引等值 + LIMIT 8（只取 id）", sql: `SELECT id FROM match WHERE status = 'pending' LIMIT 8` },
  { label: "match 索引等值（只取 id，149 行）", sql: `SELECT id FROM match WHERE status = 'pending'` },
  { label: "match 索引等值（取 round，149 行）", sql: `SELECT id, round FROM match WHERE status = 'pending'` },
  { label: "match 覆盖索引 COUNT(*)（149）", sql: `SELECT COUNT(*) AS n FROM match WHERE status = 'pending'` },
  { label: "match 索引等值 finished（只取 id，69 行）", sql: `SELECT id FROM match WHERE status = 'finished'` },
  { label: "match 覆盖索引 COUNT(*)（69）", sql: `SELECT COUNT(*) AS n FROM match WHERE status = 'finished'` },
  { label: "match 整表（只取 id，218 行）", sql: `SELECT id FROM match` },
  { label: "match 整表 COUNT(*)（218）", sql: `SELECT COUNT(*) AS n FROM match` },
  { label: "player 索引等值（只取 id）", sql: `SELECT id FROM player WHERE team_id = 1` },
  { label: "player 索引等值（取 name）", sql: `SELECT id, name FROM player WHERE team_id = 1` },
  { label: "player 覆盖索引 COUNT(*)", sql: `SELECT COUNT(*) AS n FROM player WHERE team_id = 1` },
  { label: "player 整表 COUNT(*)", sql: `SELECT COUNT(*) AS n FROM player` },
  { label: "entry 主键点查 8 行", sql: `SELECT id FROM entry WHERE id IN (1,2,3,4,5,6,7,8)` },
  { label: "entry 索引等值（只取 id）", sql: `SELECT id FROM entry WHERE tournament_id = 1` },
  { label: "主键点查 8 行 + 1 表 join", sql: `SELECT m.id, he.id AS he FROM match m JOIN entry he ON he.id = m.home_entry_id WHERE m.id IN (14,21,22,23,24,25,26,27)` },
  { label: "主键点查 8 行 + 4 表 join", sql: `SELECT m.id, he.id AS he, ht.id AS ht, ae.id AS ae, at.id AS at FROM match m JOIN entry he ON he.id = m.home_entry_id JOIN team ht ON ht.id = he.team_id JOIN entry ae ON ae.id = m.away_entry_id JOIN team at ON at.id = ae.team_id WHERE m.id IN (14,21,22,23,24,25,26,27)` },
];
const ladderOut: unknown[] = [];
for (const l of ladder) {
  const m = queryMeta(l.sql);
  const f = runWrangler(l.sql);
  const plan = explainPlan(l.sql);
  console.log(
    `  返回 ${String(m.rows).padStart(3)} 行 | --command ${String(m.rows_read).padStart(4)} 行读 | --file ${String(f.rows_read).padStart(4)} 行读  ${l.label}`,
  );
  console.log(`        ${plan.map((p) => p.replace(/USING (COVERING )?INDEX /, "·")).join(" | ")}`);
  ladderOut.push({ label: l.label, sql: l.sql, returned_rows: m.rows, command_rows_read: m.rows_read, file_rows_read: f.rows_read, plan });
}
writeFileSync("scripts/d1-read-audit/cost-model.json", JSON.stringify({ measured_at: new Date().toISOString(), ladder: ladderOut }, null, 2));
console.log("\n→ scripts/d1-read-audit/cost-model.json");
