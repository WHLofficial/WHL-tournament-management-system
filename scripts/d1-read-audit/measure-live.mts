/**
 * 实放复测（增量 38 补充）
 *
 * 桩行普查（measure-surface.mts）量的是**形状**：假 D1 的 all() 恒回 1 行，
 * 于是「per-row / per-stage」的循环在探针里只跑一次 —— LIMIT 60 的完赛窗口、
 * 11 条轮次综述、3 个阶段榜，在探针里全被压成 1 次，读数系统性偏低。
 *
 * 本脚本用 `mode: "live"`：把每条语句内联参数后**实放打生产、回真实数据行**，
 * 让应用用真实数据跑真实扇出，同时记下每条语句的 `meta.rows_read`。
 * 量到的才是线上形状（仍只读：写语句只记账不执行）。
 *
 * 用法：
 *   npx vite-node scripts/d1-read-audit/measure-live.mts --only=feed
 *   npx vite-node scripts/d1-read-audit/measure-live.mts --only=public/   # 前缀/子串匹配
 *   npx vite-node scripts/d1-read-audit/measure-live.mts --dump           # 打印完整 SQL
 *
 * 结果按面合并写 scripts/d1-read-audit/live-measurements.json。
 */
import { readFileSync, writeFileSync } from "node:fs";
import app from "../../worker/index";
import { captureSurface, oneLine, probeHeaders, type Captured } from "./harness.mts";

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice(7);
/** 支持逗号分隔多选：--only=toplists,stats,match-report */
const onlyParts = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : null;
const limitArg = args.find((a) => a.startsWith("--limit="))?.slice(8);
const extraArg = args.find((a) => a.startsWith("--extra="))?.slice(8);
/** --extra=名字:/api/public/home?limit=16|名字2:/path —— 量基线 JSON 里没有的读面 */
const extras = (extraArg ? extraArg.split("|") : [])
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(":");
    return { name: s.slice(0, i), url: s.slice(i + 1), total_rows_read: 0, statements: [] as Captured[] };
  });
const dump = args.includes("--dump");
const outFile = new URL("./live-measurements.json", import.meta.url);

/** 覆盖 URL 里的 limit（首页实际不传 limit ⇒ 默认 15；基线记录里是 limit=20）。 */
const applyLimit = (url: string): string => {
  if (!limitArg) return url;
  return url.replace(/([?&])limit=\d+/, `$1limit=${limitArg}`).replace(/\/feed$/, `/feed?limit=${limitArg}`);
};

const baseline = JSON.parse(readFileSync(new URL("./surface-measurements.json", import.meta.url), "utf8")) as {
  measured_at: string;
  sample_ids: Record<string, unknown>;
  surfaces: Array<{ name: string; url: string; total_rows_read: number; statements: Captured[] }>;
};

const targets = [
  ...baseline.surfaces.filter((s) => !onlyParts || onlyParts.some((p) => s.name.includes(p))),
  // --extra=name:/path?query|name2:/path2 —— 量基线里没有的读面（如新增的 /api/public/home）
  ...extras,
];
if (targets.length === 0) {
  console.error(`没有匹配 --only=${onlyArg} 的读面`);
  process.exit(1);
}

type LiveSurface = {
  name: string;
  url: string;
  status: number;
  stub_total_rows_read: number;
  live_total_rows_read: number;
  executed: number;
  skipped_writes: number;
  top: Array<{ sql: string; rows_read: number; result_rows: number }>;
  statements: Array<{ sql: string; args: unknown[]; rows_read: number; result_rows: number }>;
};

const results: LiveSurface[] = [];
console.log(`[实放复测] ${targets.length} 个读面（每面用全新假 env + 冷边缘缓存）\n`);

for (const t of targets) {
  const t0 = Date.now();
  const url = applyLimit(t.url);
  const r = await captureSurface(app, url, { method: "GET", headers: probeHeaders() }, { mode: "live" });
  const reads = r.statements.filter((s) => s.rows_read !== undefined);
  const writes = r.statements.filter((s) => s.rows_read === undefined);
  const liveTotal = reads.reduce((a, s) => a + (s.rows_read ?? 0), 0);
  const top = reads
    .map((s) => ({ sql: oneLine(s.sql, 130), rows_read: s.rows_read ?? 0, result_rows: s.result_rows ?? 0 }))
    .sort((a, b) => b.rows_read - a.rows_read)
    .slice(0, 8);

  results.push({
    name: limitArg ? `${t.name} (limit=${limitArg})` : t.name,
    url,
    status: r.status,
    stub_total_rows_read: t.total_rows_read,
    live_total_rows_read: liveTotal,
    executed: reads.length,
    skipped_writes: writes.length,
    top,
    statements: reads.map((s) => ({
      sql: s.sql.replace(/\s+/g, " ").trim(),
      args: s.args,
      rows_read: s.rows_read ?? 0,
      result_rows: s.result_rows ?? 0,
    })),
  });

  const ratio = t.total_rows_read ? (liveTotal / t.total_rows_read).toFixed(2) + "×" : "n/a";
  console.log(
    `${t.name.padEnd(28)} status=${r.status} 桩 ${String(t.total_rows_read).padStart(5)} → 实放 ${String(liveTotal).padStart(6)} 行 (${ratio})  执行 ${reads.length} 条 / 跳过写 ${writes.length} 条  ${Date.now() - t0}ms`,
  );
  if (dump) {
    for (const s of top) console.log(`    ${String(s.rows_read).padStart(6)}r →${String(s.result_rows).padStart(4)}行  ${s.sql}`);
  }
}

let merged: { measured_at: string; note: string; surfaces: LiveSurface[] } = {
  measured_at: new Date().toISOString(),
  note: "实放模式（mode:live）：内联参数打生产、回真实数据行，应用跑真实扇出；行读为 meta.rows_read 逐条累加。桩行模式的对照见 surface-measurements.json。",
  surfaces: [],
};
try {
  const old = JSON.parse(readFileSync(outFile, "utf8")) as typeof merged;
  merged.surfaces = old.surfaces ?? [];
} catch {
  /* 首次运行 */
}
for (const r of results) {
  const i = merged.surfaces.findIndex((s) => s.name === r.name);
  if (i >= 0) merged.surfaces[i] = r;
  else merged.surfaces.push(r);
}
writeFileSync(outFile, JSON.stringify(merged, null, 1), "utf8");

const grand = results.reduce((a, r) => a + r.live_total_rows_read, 0);
console.log(`\n本次合计：实放 ${grand} 行 / 桩行 ${results.reduce((a, r) => a + r.stub_total_rows_read, 0)} 行`);
console.log(`已写入 ${outFile.pathname.replace(/^\//, "")}`);
