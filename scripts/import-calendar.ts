// 赛历导入：calendar_s9.csv → season / season_week / time_pool / round_window
//
//   node scripts/import-calendar.ts <calendar.csv>                  # dry-run，只打印映射结果
//   node scripts/import-calendar.ts <calendar.csv> --remote --commit # 生成 SQL 并写线上 D1
//
// 映射规则与时刻池都在 worker/lib/kickoffCalendar.ts，这里只管读写与报告。

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPETITION_LABEL,
  buildCalendarSql,
  mapCalendarCsv,
  poolRows,
  tournamentName,
  type Competition,
} from "../worker/lib/kickoffCalendar.ts";
import { applySqlFile, queryD1 } from "./lib/d1.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const remote = args.includes("--remote");
const commit = args.includes("--commit");

if (!file) {
  console.error("用法：node scripts/import-calendar.ts <calendar.csv> [--remote] [--commit]");
  process.exit(1);
}

const mapping = mapCalendarCsv(readFileSync(file, "utf8"));

console.log(`赛季 ${mapping.season}：${mapping.weeks} 周，${mapping.windows.length} 个比赛窗口`);
for (const comp of Object.keys(COMPETITION_LABEL) as Competition[]) {
  const mine = mapping.windows.filter((w) => w.competition === comp);
  if (mine.length === 0) continue;
  const byStream = new Map<string, number>();
  for (const w of mine) byStream.set(w.stream, (byStream.get(w.stream) ?? 0) + 1);
  const detail = [...byStream].map(([stream, n]) => `${stream} ${n}`).join(" / ");
  console.log(`  ${COMPETITION_LABEL[comp]}：${mine.length}（${detail}）`);
  const days = new Set(mine.map((w) => `${w.week}·${w.dayStart}-${w.dayEnd}`));
  console.log(`    周次 ${[...new Set(mine.map((w) => w.week))].join(",")}；日窗口 ${days.size} 种`);
}
console.log(`时刻池：${poolRows().length} 行（4 季 × 3 赛事 × 各自比赛日）`);

if (mapping.skipped.length > 0) {
  console.log(`跳过 ${mapping.skipped.length} 条：`);
  for (const s of mapping.skipped) console.log(`  - ${s.label}（${s.category}）：${s.reason}`);
}

if (mapping.errors.length > 0) {
  console.error(`映射失败，${mapping.errors.length} 处错误：`);
  for (const e of mapping.errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

const sql = buildCalendarSql(mapping);
const statements = sql.split(/;\s*$/m).filter((s) => s.trim() !== "").length;
console.log(`SQL：${statements} 条语句，${sql.length} 字节`);

if (!commit) {
  console.log("\n（dry-run）加 --commit 才会写库；加 --remote 指向线上 D1。");
  process.exit(0);
}

// 三个赛事必须已存在：buildCalendarSql 用的是 INSERT ... SELECT，赛事名对不上会静默插 0 行。
const names = (Object.keys(COMPETITION_LABEL) as Competition[]).map((c) => tournamentName(mapping.season, c));
const quoted = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
const found = queryD1<{ name: string }>(`SELECT name FROM tournament WHERE name IN (${quoted})`, remote).map((r) => r.name);
const missing = names.filter((n) => !found.includes(n));
if (missing.length > 0) {
  console.error(`目标库缺少赛事：${missing.join("、")}（先建赛事再导赛历）`);
  process.exit(1);
}
console.log(`赛事已就位：${found.join("、")}`);

const out = join(tmpdir(), `whl-calendar-${mapping.season}-${Date.now()}.sql`);
writeFileSync(out, sql, "utf8");
console.log(`写入 ${out} → ${remote ? "线上" : "本地"} D1`);
applySqlFile(out, remote);
console.log("完成。");
