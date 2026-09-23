/**
 * 写端点的读量普查（增量 38 步骤 3 补充面）
 *
 * 为什么单独补这一轮：账号级 24h 读量 ÷ 读查询数 ≈ 173 行/查询，明显高于全站读面普查的
 * 每语句均值（约 70–75 行）——差额只能来自「普查没覆盖的读」，即写端点自己发出的读
 * （终场重算、晋级、伤停缺阵展开、阵容校验……）。这里把写端点的 SELECT 单独量一遍。
 *
 * 安全：假 D1 只记录不执行 ⇒ 写语句只被登记、绝不落库；selectOnly 再把它们剔掉，
 * 真正打到生产库的只有 SELECT。
 *
 * 用法：
 *   npx vite-node scripts/d1-read-audit/measure-writes.mts
 *   npx vite-node scripts/d1-read-audit/measure-writes.mts --only=finish
 *   npx vite-node scripts/d1-read-audit/measure-writes.mts --no-cost --dump
 */
import { writeFileSync } from "node:fs";
import app from "../../worker/index";
import { FORMS } from "../../shared/tactics";
import {
  captureSurface,
  costOf,
  makeFakeEnv,
  oneLine,
  probeHeaders,
  queryRows,
  selectOnly,
  setValueHints,
  type Captured,
} from "./harness.mts";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const noCost = args.includes("--no-cost");
const dump = args.includes("--dump");

/* ── 线上样本 id（与 measure-surface 同源取法） ── */
const row = (sql: string) => queryRows(sql)[0] ?? {};
const tid = Number(row("SELECT id AS v FROM tournament ORDER BY id LIMIT 1").v);
const stages =
  queryRows(
    "SELECT s.id AS id, (SELECT count(*) FROM match m WHERE m.stage_id = s.id) AS mc FROM stage s ORDER BY mc DESC LIMIT 1",
  )[0] ?? {};
const sid = Number(stages.id);
const busiest =
  queryRows(`SELECT id FROM match WHERE stage_id = ${sid} ORDER BY id DESC LIMIT 1`)[0] ?? {};
const mid = Number(busiest.id);
const fin = queryRows("SELECT id FROM match WHERE status = 'finished' ORDER BY id DESC LIMIT 1")[0] ?? {};
const midFin = Number(fin.id);
const team = Number(row("SELECT id AS v FROM team ORDER BY id LIMIT 1").v);
const inj = queryRows("SELECT id AS v FROM injury ORDER BY id LIMIT 1")[0] ?? {};
const injId = Number(inj.v);

console.log(`[样本 id] tournament=${tid} 阶段=${sid}(132 场) 待打场次=${mid} 已结束场次=${midFin} 球队=${team} 伤停=${injId}`);

/* ── 写面清单 ──
 * `hints` 覆盖桩行的关键列值：写端点的状态前置校验彼此冲突（开赛要 pending、
 * 录事件要非 pending、赛事状态机只认 draft/registering/running/archived），
 * 不覆盖就会在前置守卫处提前退出、量不到后面的 SQL。 */
interface WriteSurface {
  name: string;
  method: string;
  url: string;
  body?: string;
  hints?: Record<string, string>;
  note?: string;
}

const H = "https://probe.local";
const J = (o: unknown) => JSON.stringify(o);
const json = { "content-type": "application/json" };

/** 一份校验得过的最低成本阵容：阵型取 4-3-3，11 个位置各配一个球员。 */
const form433 = FORMS.find((f) => f.value === "4-3-3") ?? FORMS[0]!;
const lineupBody = J({
  form: form433.value,
  code: "",
  slots: form433.pos.map((p, i) => ({ lid: p.lid, position: p.position, player_id: i + 1 })),
});

const surfaces: WriteSurface[] = [
  { name: "admin/match-start", method: "POST", url: `${H}/api/admin/matches/${mid}/start`, hints: { status: "pending" } },
  { name: "admin/match-finish", method: "POST", url: `${H}/api/admin/matches/${midFin}/finish`, body: J({ scoreHome: 2, scoreAway: 1 }) },
  { name: "admin/match-finish-walkover", method: "POST", url: `${H}/api/admin/matches/${midFin}/finish`, body: J({ walkoverSide: "home" }) },
  { name: "admin/match-event-post", method: "POST", url: `${H}/api/admin/matches/${midFin}/events`, body: J({ type: "goal", entryId: 1, playerId: 1, minute: 10 }), hints: { status: "live" } },
  { name: "admin/match-event-put", method: "PUT", url: `${H}/api/admin/matches/${midFin}/events/1`, body: J({ type: "yellow", entryId: 1, playerId: 1, minute: 11 }), hints: { status: "live" } },
  { name: "admin/match-event-delete", method: "DELETE", url: `${H}/api/admin/matches/${midFin}/events/1`, hints: { status: "live" } },
  { name: "admin/injury-post", method: "POST", url: `${H}/api/admin/injuries`, body: J({ eventId: 1, playerId: 1, missMatchIds: [midFin] }), hints: { type: "injury_minor" }, note: "桩行的 injury 行恒存在 ⇒ 在「该事件已建过登记」的 409 处停下，量到的是前置读" },
  { name: "admin/injury-put", method: "PUT", url: `${H}/api/admin/injuries/${injId}`, body: J({ note: "探针", missMatchIds: [midFin] }), hints: { type: "injury_minor" }, note: "同上，桩行让它在守卫处停下" },
  { name: "admin/injury-delete", method: "DELETE", url: `${H}/api/admin/injuries/${injId}` },
  { name: "admin/tournament-transition", method: "POST", url: `${H}/api/admin/tournaments/${tid}/transition`, body: J({ to: "registering" }), hints: { status: "draft" } },
  { name: "admin/team-post", method: "POST", url: `${H}/api/admin/teams`, body: J({ gameTeamId: 999999, name: "探针队" }), note: "桩行的「id 是否被占用」恒为真 ⇒ 409 停下，量到的是前置读" },
  { name: "admin/team-patch", method: "PATCH", url: `${H}/api/admin/teams/${team}`, body: J({ name: "探针队" }) },
  { name: "admin/entries-bulk", method: "POST", url: `${H}/api/admin/tournaments/${tid}/entries/bulk`, body: J({ lines: ["1 探针队"] }), hints: { status: "registering" } },
  { name: "coach/lineup-put", method: "PUT", url: `${H}/api/coach/matches/${mid}/lineup`, body: lineupBody, hints: { status: "pending", home_tid: 1, away_tid: 1 } },
  { name: "coach/tactics-post", method: "POST", url: `${H}/api/coach/tactics`, body: J({ code: "12345678901", note: "探针", form: "4-3-3", buildup: "short", lineHeight: 50, roster: {}, assign: {} }) },
  { name: "interact/motm-post", method: "POST", url: `${H}/api/interact/matches/${midFin}/motm`, body: J({ playerId: 1 }) },
];

/* ── 跑普查 ── */
interface WriteReport {
  name: string;
  method: string;
  url: string;
  status: number | string;
  error?: string;
  note?: string;
  statements: Array<{ sql: string; args: unknown[]; db: string; rows_read: number }>;
  skipped_writes: string[];
  skipped_write_count: number;
  total_rows_read: number;
  duration_ms: number;
}

const reports: WriteReport[] = [];
const t0 = Date.now();

for (const s of surfaces) {
  if (only && !s.name.includes(only)) continue;
  setValueHints(s.hints);
  const init: RequestInit = {
    method: s.method,
    headers: { ...probeHeaders(), ...(s.body ? json : {}) },
  };
  if (s.body) init.body = s.body;

  const cap = await captureSurface(app, s.url, init);
  const { keep, skipped } = selectOnly(cap.statements);
  const started = Date.now();
  let perStatement: WriteReport["statements"] = [];
  let total = 0;
  if (!noCost) {
    const cost = costOf(keep);
    perStatement = cost.perStatement.map((p, i) => ({
      sql: keep[i]!.sql,
      args: keep[i]!.args,
      db: keep[i]!.db,
      rows_read: p.rows_read,
    }));
    total = cost.total;
  }
  const rep: WriteReport = {
    name: s.name,
    method: s.method,
    url: s.url,
    status: cap.status,
    error: cap.error,
    note: s.note,
    statements: perStatement,
    skipped_writes: skipped.map((x) => oneLine(x.sql, 90)),
    skipped_write_count: skipped.length,
    total_rows_read: total,
    duration_ms: Date.now() - started,
  };
  reports.push(rep);
  console.log(
    `${String(cap.status).padEnd(4)} ${s.name.padEnd(28)} ${noCost ? "?" : total} 行读 / ${keep.length} 条 SELECT / ${skipped.length} 条写被跳过  ${Date.now() - started}ms` +
      (cap.error ? `  ERR=${cap.error}` : ""),
  );
  if (dump) {
    for (const st of keep) {
      console.log(`    [${st.db}] ${oneLine(st.sql, 150)}`);
      console.log(`         args=${JSON.stringify(st.args)}`);
    }
    for (const w of skipped) console.log(`    (写·跳过) ${oneLine(w.sql, 120)}`);
  }
}
setValueHints();

const grand = reports.reduce((a, r) => a + r.total_rows_read, 0);
const stmts = reports.reduce((a, r) => a + r.statements.length, 0);
console.log(
  `\n合计 ${reports.length} 个写面 / ${stmts} 条 SELECT / ${grand} 行读 / 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
const top = [...reports].sort((a, b) => b.total_rows_read - a.total_rows_read).slice(0, 10);
console.log("最贵的写面：");
for (const r of top) console.log(`  ${String(r.total_rows_read).padStart(6)} 行  ${r.name}（${r.statements.length} 条）`);

if (!noCost && !only) {
  const out = {
    measured_at: new Date().toISOString(),
    method: "假 D1 抓写端点的 SQL → 只留 SELECT → 逐条打生产库读回 meta.rows_read（--command 通道）",
    boundaries: [
      "假 D1 只记录不执行：写语句绝不落库，本文件的行读只含各写端点发出的 SELECT",
      "桩行值与真实数据不同，走的是「探针形状」；写端点因前置守卫不同需要覆盖桩行关键列（hints）",
      "冷路径：KV 与边缘缓存都冷",
      "样本 id 取自当时线上（见上面 [样本 id] 行）",
    ],
    sample_ids: { tournament: tid, stage: sid, match: mid, match_finished: midFin, team, injury: injId },
    surfaces: reports,
    grand_total_rows_read: grand,
  };
  writeFileSync(new URL("./write-path-measurements.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\n→ 已写入 scripts/d1-read-audit/write-path-measurements.json");
}
