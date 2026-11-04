// 开球时刻回填：插件导出的赛程 CSV → tour match.kickoff_week/day/time
//
//   node scripts/backfill-kickoff.ts <fixtures.csv> S9            # dry-run，打印对账报告
//   node scripts/backfill-kickoff.ts <fixtures.csv> S9 --remote --commit
//
// 只认「已存在且能唯一对上」的场次：主客反了、命中多场、轮次对不上的都进未命中清单，
// 一条都不猜。dry-run 会顺带复算同队间隔约束（P3-A 的验收口径）。

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBackfillSql,
  parseFixtureCsv,
  planBackfill,
  replayConstraints,
  type DbMatchRow,
} from "../worker/lib/kickoffCalendar.ts";
import { applySqlFile, queryD1 } from "./lib/d1.ts";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [file, season] = positional;
const remote = args.includes("--remote");
const commit = args.includes("--commit");

if (!file || !season) {
  console.error("用法：node scripts/backfill-kickoff.ts <fixtures.csv> <season> [--remote] [--commit]");
  process.exit(1);
}

const parsed = parseFixtureCsv(readFileSync(file, "utf8"));
if (parsed.errors.length > 0) {
  console.error(`赛程 CSV 有 ${parsed.errors.length} 处错误：`);
  for (const e of parsed.errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`赛程 ${parsed.rows.length} 场（${file}）`);

type Row = DbMatchRow & { kickoff_time: string | null };
const prefix = `${season} | `;
const rows = queryD1<Row>(
  `SELECT m.id AS id, t.name AS tournament_name, s.id AS stage_id, s.sort_order AS stage_sort,
          s.kind AS stage_kind, m.round AS round, m.leg AS leg,
          ht.name AS home_name, at.name AS away_name, m.kickoff_time AS kickoff_time
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team at ON at.id = ae.team_id
    WHERE t.name LIKE '${prefix.replace(/'/g, "''")}%'
    ORDER BY m.id`,
  remote,
);
console.log(`库里 ${rows.length} 场（${prefix}*）`);

const plan = planBackfill(parsed.rows, rows);
console.log(`命中 ${plan.updates.length} / ${parsed.rows.length}`);

const byTournament = new Map<string, number>();
for (const u of plan.updates) {
  // label 前缀就是赛事名（顶级联赛22 / 冠军杯小组赛3）
  const label = u.label.replace(/\d+.*$/, "");
  byTournament.set(label, (byTournament.get(label) ?? 0) + 1);
}
for (const [label, n] of byTournament) console.log(`  ${label}：${n}`);

if (plan.unmatched.length > 0) {
  console.log(`未命中 ${plan.unmatched.length} 场：`);
  for (const u of plan.unmatched.slice(0, 30)) {
    console.log(`  - ${u.fixture.label} ${u.fixture.home} vs ${u.fixture.away}：${u.reason}`);
  }
  if (plan.unmatched.length > 30) console.log(`  … 另有 ${plan.unmatched.length - 30} 场`);
}

const overwrite = plan.updates.filter((u) => {
  const row = rows.find((r) => r.id === u.matchId);
  return row?.kickoff_time !== null;
}).length;
if (overwrite > 0) console.log(`注意：${overwrite} 场已有时刻，会被覆盖`);

const replay = replayConstraints(
  plan.updates.map((u) => ({ matchId: u.matchId, home: u.home, away: u.away, week: u.week, day: u.day, time: u.time })),
);
console.log(
  `约束回放：${replay.matches} 场 / ${replay.teams} 队 / ${replay.pairs} 对，最小间隔 ${replay.minGapHours}h，` +
    `<64h ${replay.under64} 对、<72h ${replay.under72} 对`,
);
for (const p of replay.under48) {
  console.log(`  ✗ <48h：${p.team} match ${p.firstMatchId} → ${p.secondMatchId} 仅 ${p.gapHours}h`);
}
if (replay.under48.length > 0) process.exit(1);

if (!commit) {
  console.log("\n（dry-run）加 --commit 才会写库；加 --remote 指向线上 D1。");
  process.exit(0);
}

const out = join(tmpdir(), `whl-backfill-${season}-${Date.now()}.sql`);
writeFileSync(out, buildBackfillSql(plan), "utf8");
console.log(`写入 ${out} → ${remote ? "线上" : "本地"} D1`);
applySqlFile(out, remote);

const filled = queryD1<{ n: number }>(
  `SELECT COUNT(*) AS n FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
    WHERE t.name LIKE '${prefix.replace(/'/g, "''")}%' AND m.kickoff_time IS NOT NULL`,
  remote,
);
console.log(`回填后时刻非空：${filled[0]?.n ?? 0} 场`);
