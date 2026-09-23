/**
 * 全站读面普查（增量 38 步骤 3）
 *
 * 对每个真实读面：直调 worker 的 Hono 应用抓下它发出的全部 SQL → 逐条打到生产库读回 `rows_read`。
 * 每个读面用**全新假 env**（KV 冷、边缘缓存冷），量到的是冷路径读数——治理取保守值。
 *
 * 用法：
 *   npx vite-node scripts/d1-read-audit/measure-surface.mts                 # 全量普查
 *   npx vite-node scripts/d1-read-audit/measure-surface.mts --only=feed     # 只跑名字含 feed 的
 *   npx vite-node scripts/d1-read-audit/measure-surface.mts --no-cost       # 只抓 SQL 不打生产（快速排查路由报错）
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import app from "../../worker/index";
import { runAccountMirror } from "../../worker/lib/accountMirror";
import { runRosterSync } from "../../worker/lib/clubRoster";
import type { Bindings } from "../../worker/env";
import {
  captureSurface,
  costOf,
  d1Info,
  makeFakeEnv,
  oneLine,
  probeHeaders,
  queryRows,
  runWrangler,
  selectOnly,
  type Captured,
} from "./harness.mts";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const noCost = args.includes("--no-cost");
/** 打印完整 SQL 与绑定参数（排查形状、设计改写用；平时只打截断预览）。 */
const dump = args.includes("--dump");

/* ── 线上样本 id（2026-09-23 实测取回；换了数据只需重取，脚本不改） ── */
const row = (sql: string) => queryRows(sql)[0] ?? {};
const t1 = Number(row("SELECT id AS v FROM tournament ORDER BY id LIMIT 1").v); // 1 → S9 顶级联赛
const stages = queryRows(
  "SELECT s.id AS id, s.tournament_id AS tid, (SELECT count(*) FROM match m WHERE m.stage_id = s.id) AS mc FROM stage s ORDER BY mc DESC LIMIT 1",
)[0] ?? {};
const sid = Number(stages.id); // 132 场那个阶段
const tid = Number(stages.tid);
const busiest = queryRows(
  `SELECT id, round FROM match WHERE stage_id = ${sid} ORDER BY id DESC LIMIT 1`,
)[0] ?? {};
const mid = Number(busiest.id); // 场次最多的阶段里的最新一场
const round = Number(busiest.round);
const fin = queryRows(
  "SELECT id FROM match WHERE status = 'finished' ORDER BY id DESC LIMIT 1",
)[0] ?? {};
const midFin = Number(fin.id);
const team = Number(row("SELECT id AS v FROM team ORDER BY id LIMIT 1").v);
const grantMid = Number(
  (queryRows("SELECT match_id AS v FROM lineup_proxy_grant ORDER BY id DESC LIMIT 1")[0] ?? {}).v ?? mid,
);

console.log(
  `[样本 id] tournament=${t1} 阶段=${sid}(t${tid}, round=${round}) 场次=${mid} 已结束场次=${midFin} 球队=${team} 授权场次=${grantMid}`,
);

/* ── 读面清单 ── */
interface Surface {
  name: string;
  method?: string;
  url: string;
  body?: string;
  /** 需要登录态（带探针会话 cookie） */
  auth?: boolean;
  /**
   * 额外请求头。给函数是为了机器通道：签名含秒级时间戳、验签窗口只有 ±300s，
   * 而普查全程要十几分钟——必须在**发请求那一刻**才算签名，否则轮到它时必然过期。
   */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** 只读面附带说明（如「数据真源在 auth，本库只花会话查询」） */
  note?: string;
}

const H = "https://probe.local";
const surfaces: Surface[] = [
  // 公开面（无 cookie；pubCache 覆盖，冷缓存）
  { name: "public/tournaments", url: `${H}/api/public/tournaments` },
  { name: "public/tournament", url: `${H}/api/public/tournaments/${t1}` },
  { name: "public/tournament-matches", url: `${H}/api/public/tournaments/${t1}/matches?stageId=${sid}&round=${round}` },
  { name: "public/tournament-rounds", url: `${H}/api/public/tournaments/${t1}/matches/rounds` },
  { name: "public/tournament-summary", url: `${H}/api/public/tournaments/${t1}/matches/summary` },
  { name: "public/match", url: `${H}/api/public/tournaments/${t1}/matches/${mid}` },
  { name: "public/match-lineup", url: `${H}/api/public/matches/${mid}/lineup` },
  { name: "public/match-h2h", url: `${H}/api/public/tournaments/${t1}/matches/${mid}/h2h` },
  { name: "public/match-lineup-stats", url: `${H}/api/public/tournaments/${t1}/matches/${mid}/lineup-stats` },
  { name: "public/upcoming", url: `${H}/api/public/upcoming` },
  { name: "public/live", url: `${H}/api/public/live` },
  { name: "public/recent", url: `${H}/api/public/recent` },
  { name: "public/standings", url: `${H}/api/public/tournaments/${tid}/standings` },
  { name: "public/toplists", url: `${H}/api/public/tournaments/${tid}/toplists` },
  { name: "public/injuries", url: `${H}/api/public/tournaments/${tid}/injuries` },
  { name: "public/stats", url: `${H}/api/public/tournaments/${tid}/stats` },
  { name: "public/announcement", url: `${H}/api/public/announcement` },
  { name: "public/feed", url: `${H}/api/public/feed?limit=20` },
  { name: "public/weekly", url: `${H}/api/public/weekly` },
  { name: "public/match-report", url: `${H}/api/public/matches/${midFin}/report` },
  { name: "public/round", url: `${H}/api/public/tournaments/${tid}/round/${sid}/${round}` },
  // 互动层
  { name: "interact/reactions", url: `${H}/api/interact/reactions?ids=match:${mid},match:${midFin}` },
  { name: "interact/motm", url: `${H}/api/interact/matches/${mid}/motm`, auth: true },
  // 教练面
  { name: "coach/me-team", url: `${H}/api/coach/me/team`, auth: true },
  { name: "coach/me-matches", url: `${H}/api/coach/me/matches?tournamentId=${tid}`, auth: true },
  { name: "coach/me-status", url: `${H}/api/coach/me/status`, auth: true },
  { name: "coach/match-lineup", url: `${H}/api/coach/matches/${mid}/lineup`, auth: true },
  { name: "coach/proxy-sessions", url: `${H}/api/coach/proxy/sessions`, auth: true },
  { name: "coach/proxy-board", url: `${H}/api/coach/proxy/${mid}/board`, auth: true },
  { name: "coach/tactics", url: `${H}/api/coach/tactics`, auth: true },
  // 管理面
  // 以下 5 个面的数据真源在认证中心（经 authAdmin.ts 的 machineCall 转发 HTTP），
  // 本库花费只有 attachUser 的会话查询；它们的读负载记在 whl-auth 上。
  { name: "admin/org-settings", url: `${H}/api/admin/org-settings`, auth: true, note: "转发认证中心，本库只有会话查询" },
  { name: "admin/teams", url: `${H}/api/admin/teams`, auth: true },
  { name: "admin/team", url: `${H}/api/admin/teams/${team}`, auth: true },
  { name: "admin/team-members", url: `${H}/api/admin/teams/${team}/members`, auth: true },
  { name: "admin/team-codes", url: `${H}/api/admin/teams/${team}/auth-codes`, auth: true },
  { name: "admin/tournaments", url: `${H}/api/admin/tournaments`, auth: true },
  { name: "admin/tournament", url: `${H}/api/admin/tournaments/${tid}`, auth: true },
  { name: "admin/tournament-standings", url: `${H}/api/admin/tournaments/${tid}/standings`, auth: true },
  { name: "admin/tournament-matches", url: `${H}/api/admin/tournaments/${tid}/matches`, auth: true },
  { name: "admin/match-events", url: `${H}/api/admin/matches/${mid}/events`, auth: true },
  { name: "admin/match-lineup", url: `${H}/api/admin/matches/${mid}/lineup`, auth: true },
  { name: "admin/accounts", url: `${H}/api/admin/accounts`, auth: true, note: "转发认证中心，本库只有会话查询" },
  { name: "admin/accounts-catalog", url: `${H}/api/admin/accounts/catalog`, auth: true, note: "转发认证中心，本库只有会话查询" },
  { name: "admin/audit", url: `${H}/api/admin/audit?limit=50`, auth: true, note: "转发认证中心，本库只有会话查询" },
  { name: "admin/announcements", url: `${H}/api/admin/announcements`, auth: true },
  { name: "admin/injuries", url: `${H}/api/admin/injuries`, auth: true },
  { name: "admin/injury-events", url: `${H}/api/admin/injuries/events?teamId=${team}`, auth: true },
  { name: "admin/injury-candidates", url: `${H}/api/admin/injuries/candidates?teamId=${team}`, auth: true },
  { name: "admin/proxy-grants", url: `${H}/api/admin/proxy-grants`, auth: true },
  { name: "admin/signup-codes", url: `${H}/api/admin/signup-codes`, auth: true, note: "转发认证中心，本库只有会话查询" },
  { name: "admin/rosters-context", url: `${H}/api/admin/proxy-grants/context`, auth: true },
  // 其它
  { name: "health", url: `${H}/api/health` },
];

/* ── 机器通道：按 clubSync 的签名规则自签（时间戳在发请求时才算，见 Surface.headers 注释） ── */
function internalUpsert(secret: string, body: string): Surface {
  return {
    name: "internal/team-upsert",
    method: "POST",
    url: `${H}/api/internal/team-upsert`,
    body,
    headers: () => {
      const ts = Math.floor(Date.now() / 1000);
      const sign = createHmac("sha256", secret)
        .update(`POST|/api/internal/team-upsert|${ts}|${body}`)
        .digest("hex");
      return { "content-type": "application/json", "x-timestamp": String(ts), "x-sign": sign };
    },
  };
}
surfaces.push(internalUpsert("probe-secret", JSON.stringify({ id: 999999, name: "探针队", operator: "probe" })));

/* ── 跑普查 ── */
interface SurfaceReport {
  name: string;
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

const reports: SurfaceReport[] = [];
const t0 = Date.now();

for (const s of surfaces) {
  if (only && !s.name.includes(only)) continue;
  const extra = typeof s.headers === "function" ? s.headers() : (s.headers ?? {});
  const init: RequestInit = {
    method: s.method ?? "GET",
    headers: { ...(s.auth ? probeHeaders() : {}), ...extra },
  };
  if (s.body) init.body = s.body;

  const cap = await captureSurface(app, s.url, init);
  const { keep, skipped } = selectOnly(cap.statements);
  const started = Date.now();
  let perStatement: SurfaceReport["statements"] = [];
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
  const rep: SurfaceReport = {
    name: s.name,
    url: s.url,
    status: cap.error ? "ERR" : cap.status,
    ...(cap.error ? { error: cap.error } : {}),
    ...(s.note ? { note: s.note } : {}),
    statements: perStatement,
    skipped_writes: skipped.map((w: Captured) => oneLine(w.sql, 160)),
    skipped_write_count: skipped.length,
    total_rows_read: total,
    duration_ms: Date.now() - started,
  };
  reports.push(rep);
  const mark = cap.error ? "✗" : cap.status >= 400 ? "!" : "·";
  console.log(
    `${mark} ${s.name.padEnd(30)} ${String(total).padStart(7)} 行读  ` +
      `${keep.length} 条查询${skipped.length ? ` (+${skipped.length} 条写被跳过)` : ""}` +
      `${cap.error ? `  ${cap.error.slice(0, 90)}` : cap.status >= 400 ? `  HTTP ${cap.status}${s.note ? `（${s.note}）` : ""}` : ""}`,
  );
  if (dump) {
    for (const p of perStatement) {
      console.log(`    [${p.rows_read} 行 · ${p.db}] ${p.sql}`);
      if (p.args.length) console.log(`      参数 ${JSON.stringify(p.args)}`);
    }
    for (const w of rep.skipped_writes) console.log(`    [写·跳过] ${w}`);
  }
}

/* ── cron 两段（独立成面；同样用假 D1 抓 SQL） ── */
if (!only || "cron-roster-sync".includes(only) || "cron-account-mirror".includes(only)) {
  const cronSurfaces: Array<{ name: string; run: (env: Bindings) => Promise<unknown> }> = [
    { name: "cron-roster-sync", run: (env) => runRosterSync(env) },
    { name: "cron-account-mirror", run: (env) => runAccountMirror(env) },
  ];
  for (const cs of cronSurfaces) {
    if (only && !cs.name.includes(only)) continue;
    const sink: Captured[] = [];
    const env = makeFakeEnv(sink) as unknown as Bindings;
    let err: string | undefined;
    const started = Date.now();
    try {
      await cs.run(env);
    } catch (e) {
      err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    const { keep, skipped } = selectOnly(sink);
    const cost = noCost ? { perStatement: [], total: 0 } : costOf(keep);
    reports.push({
      name: cs.name,
      url: "(cron)",
      status: err ? "ERR" : 200,
      ...(err ? { error: err } : {}),
      statements: cost.perStatement.map((p, i) => ({
        sql: keep[i]!.sql,
        args: keep[i]!.args,
        db: keep[i]!.db,
        rows_read: p.rows_read,
      })),
      skipped_writes: skipped.map((w) => oneLine(w.sql, 160)),
      skipped_write_count: skipped.length,
      total_rows_read: cost.total,
      duration_ms: Date.now() - started,
    });
    console.log(`${err ? "✗" : "·"} ${cs.name.padEnd(30)} ${String(cost.total).padStart(7)} 行读  ${keep.length} 条查询${skipped.length ? ` (+${skipped.length} 条写被跳过)` : ""}${err ? `  ${err.slice(0, 90)}` : ""}`);
  }
}

/* ── 汇总与落盘 ── */
const ranked = [...reports].sort((a, b) => b.total_rows_read - a.total_rows_read);
const grandTotal = reports.reduce((n, r) => n + r.total_rows_read, 0);
console.log(`\n合计 ${reports.length} 个读面：${grandTotal} 行读（单次冷路径），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`超过 10,000 行/次触发治理阈值的读面：${ranked.filter((r) => r.total_rows_read >= 10000).length} 个`);

const d1 = (n: string) => {
  try {
    return d1Info(n);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

if (!noCost) {
  const path = "scripts/d1-read-audit/surface-measurements.json";
  // `--only=` 是复测口径：只跑个别读面时，按名字合并回既有结果，别把普查成果冲掉。
  let merged = ranked;
  if (only) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as { surfaces?: SurfaceReport[] };
      const fresh = new Map(ranked.map((r) => [r.name, r]));
      merged = [...(prev.surfaces ?? []).filter((r) => !fresh.has(r.name)), ...ranked].sort(
        (a, b) => b.total_rows_read - a.total_rows_read,
      );
    } catch {
      /* 没有旧结果就是首次全量，直接用本轮 */
    }
  }
  const out = {
    measured_at: new Date().toISOString(),
    note: "每个读面独立冷路径：假 KV 空、边缘缓存空；逐条语句打到生产 D1 读回 meta.rows_read",
    boundaries: [
      "走 wrangler d1 execute 管理通道量物理行读，不等价于 worker 运行时通道（后者才有 RPC 与限制）",
      "假 D1 只记录不执行：桩行值可能与真实数据不同，因此分支走的是「探针形状」而非线上百分之百同一分支",
      "抽样读面取的是当时线上真实 id；样本场次无事件类数据时（如 admin/match-events）读量为 0 属取样偏差",
      "冷路径：量的是缓存未命中时的读数，线上命中边缘缓存/KV 的请求不产生这些行读",
    ],
    account_d1_24h: {
      whl: d1("whl"),
      "whl-club": d1("whl-club"),
      "whl-auth": d1("whl-auth"),
      "whl-guess": d1("whl-guess"),
    },
    sample_ids: { t1, sid, tid, mid, round, midFin, team, grantMid },
    surfaces: merged,
    grand_total_rows_read: merged.reduce((n, r) => n + r.total_rows_read, 0),
  };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`已写入 ${path}（${merged.length} 个读面）`);
}

/** 顺带量一条纯 SQL 的读数，便于核对量级（应约等于 player 表行数）。 */
if (!noCost) {
  const probe = runWrangler("SELECT count(*) AS n FROM player");
  console.log(`[核对] SELECT count(*) FROM player → ${probe.rows_read} 行读`);
}
