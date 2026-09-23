/**
 * 形状排行（增量 38 步骤 2 的归并部分）
 *
 * `measure-surface.mts` 已经给出「每个读面花多少行读」；这里换个切面回答
 * 「哪条 SQL 形状最贵、它被哪些读面共用、贵在哪张表」——治理要改的是形状，不是读面。
 *
 * 输入：scripts/d1-read-audit/surface-measurements.json
 * 输出：控制台排行 + scripts/d1-read-audit/shape-ranking.json
 *
 * 用法：npx vite-node scripts/d1-read-audit/rank-shapes.mts [--top=30]
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const top = Number(args.find((a) => a.startsWith("--top="))?.slice(6)) || 30;
const IN = "scripts/d1-read-audit/surface-measurements.json";
const OUT = "scripts/d1-read-audit/shape-ranking.json";

interface Statement {
  sql: string;
  args: unknown[];
  db: string;
  rows_read: number;
}
interface Surface {
  name: string;
  status: number | string;
  note?: string;
  statements: Statement[];
  skipped_write_count: number;
  total_rows_read: number;
}
interface Census {
  measured_at: string;
  account_d1_24h: Record<string, Record<string, unknown>>;
  surfaces: Surface[];
  grand_total_rows_read: number;
}

const census = JSON.parse(readFileSync(IN, "utf8")) as Census;

/** 归一化：折叠空白（字面量里的空白折叠不影响形状判定，够用）。 */
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
/** 主表：第一条 FROM/JOIN 后的表名（SQLite 里就是驱动表，读量主要来自它）。 */
function primaryTable(sql: string): string {
  const m = /(?:from|join)\s+([a-z_][a-z0-9_]*)/i.exec(sql);
  return m ? m[1]!.toLowerCase() : "(unknown)";
}

interface Shape {
  sql: string;
  table: string;
  rows_read: number;
  calls: number;
  surfaces: string[];
}
const shapes = new Map<string, Shape>();
const perTable = new Map<string, { rows_read: number; statements: number }>();
const perSurfaceTable = new Map<string, Map<string, number>>();

for (const s of census.surfaces) {
  const byTable = new Map<string, number>();
  for (const st of s.statements) {
    const key = norm(st.sql);
    const t = primaryTable(st.sql);
    const existing = shapes.get(key);
    if (existing) {
      existing.rows_read += st.rows_read;
      existing.calls += 1;
      if (!existing.surfaces.includes(s.name)) existing.surfaces.push(s.name);
    } else {
      shapes.set(key, { sql: key, table: t, rows_read: st.rows_read, calls: 1, surfaces: [s.name] });
    }
    const tb = perTable.get(t) ?? { rows_read: 0, statements: 0 };
    tb.rows_read += st.rows_read;
    tb.statements += 1;
    perTable.set(t, tb);
    byTable.set(t, (byTable.get(t) ?? 0) + st.rows_read);
  }
  perSurfaceTable.set(s.name, byTable);
}

const ranked = [...shapes.values()].sort((a, b) => b.rows_read - a.rows_read);
const tables = [...perTable.entries()].sort((a, b) => b[1].rows_read - a[1].rows_read);

/* ── 读面内部归因：某读面最贵的那条 SQL 是哪张表 ── */
const surfaceHog = census.surfaces
  .map((s) => {
    const byTable = perSurfaceTable.get(s.name)!;
    const [tbl, r] = [...byTable.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["(none)", 0];
    return { name: s.name, total: s.total_rows_read, top_table: tbl, top_table_rows: r };
  })
  .sort((a, b) => b.total - a.total);

const totalRows = census.surfaces.reduce((n, s) => n + s.total_rows_read, 0);
const totalStatements = census.surfaces.reduce((n, s) => n + s.statements.length, 0);

console.log(`普查时间 ${census.measured_at}｜${census.surfaces.length} 个读面｜${totalStatements} 条语句｜${totalRows} 行读（单次冷路径合计）\n`);

console.log(`── 表读量排行（归因到驱动表） ──`);
for (const [t, v] of tables.slice(0, 12)) {
  console.log(`  ${t.padEnd(20)} ${String(v.rows_read).padStart(7)} 行  ${String(v.statements).padStart(3)} 条语句  ${((v.rows_read / totalRows) * 100).toFixed(1)}%`);
}

console.log(`\n── 最贵形状 Top ${top} ──`);
ranked.slice(0, top).forEach((s, i) => {
  console.log(
    `${String(i + 1).padStart(3)}. ${String(s.rows_read).padStart(7)} 行 ×${s.calls}  [${s.table}]  ${s.surfaces.slice(0, 3).join(",")}${s.surfaces.length > 3 ? `+${s.surfaces.length - 3}` : ""}`,
  );
  console.log(`     ${s.sql.slice(0, 150)}${s.sql.length > 150 ? "…" : ""}`);
});

console.log(`\n── 读面榜（前 15） ──`);
for (const s of surfaceHog.slice(0, 15)) {
  console.log(`  ${s.name.padEnd(30)} ${String(s.total).padStart(7)} 行  （最贵表 ${s.top_table} ${s.top_table_rows}）`);
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      measured_at: census.measured_at,
      source: IN,
      totals: { surfaces: census.surfaces.length, statements: totalStatements, rows_read: totalRows },
      tables: tables.map(([t, v]) => ({ table: t, ...v, share: Number((v.rows_read / totalRows).toFixed(4)) })),
      shapes: ranked.map((s) => ({ ...s, share: Number((s.rows_read / totalRows).toFixed(4)) })),
      surfaces_ranked: surfaceHog,
      repeated_shapes: ranked.filter((s) => s.surfaces.length > 1).length,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log(`\n已写入 ${OUT}`);
