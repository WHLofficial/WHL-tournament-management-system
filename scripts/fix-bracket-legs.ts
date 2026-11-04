// 一次性数据修复：淘汰赛实际场次的腿数与赛制/赛历对齐（S9）。
//
//  1) 冠军杯决赛：赛制为单回合 —— 阶段 config 补 `final_legs: 1`，删掉已生成的决赛 leg2。
//  2) 次级附加赛：赛制为双回合 —— 把 leg=NULL 的占位行改成 leg=1，并补出 leg=2。
//
// 只在「pending + 无比分 + 无事件 + 双方未定」的场次上动手；其余情况直接报错退出，
// 免得把已经踢过或已经挂上人的场次改坏。
//
// 用法：node scripts/fix-bracket-legs.ts [--remote] [--commit]

import { execD1, queryD1 } from "./lib/d1.ts";

const remote = process.argv.includes("--remote");
const commit = process.argv.includes("--commit");

interface StageRow {
  id: number;
  name: string | null;
  tournament_name: string;
  kind: string;
  config_json: string | null;
}

interface MatchRow {
  id: number;
  round: number;
  slot: number;
  leg: number | null;
  status: string;
  score_home: number | null;
  score_away: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
}

const statements: string[] = [];
const notes: string[] = [];

function assertClean(m: MatchRow, why: string): void {
  const dirty =
    m.status !== "pending" ||
    m.score_home !== null ||
    m.score_away !== null ||
    m.home_entry_id !== null ||
    m.away_entry_id !== null;
  if (dirty) {
    throw new Error(
      `${why}：match ${m.id} 不是空白占位（status=${m.status} 比分=${m.score_home}-${m.score_away} 双方=${m.home_entry_id}/${m.away_entry_id}），拒绝修改`
    );
  }
}

const stages = queryD1<StageRow>(
  `SELECT s.id, s.name, s.kind, s.config_json, t.name AS tournament_name
     FROM stage s JOIN tournament t ON t.id = s.tournament_id
    WHERE s.kind = 'elim' AND (t.name LIKE '%冠军杯' OR t.name LIKE '%次级联赛')
    ORDER BY t.name, s.sort_order`,
  remote
);

// ---------- 1. 冠军杯决赛单回合 ----------
const cup = stages.find((s) => s.tournament_name.includes("冠军杯"));
if (!cup) throw new Error("没找到冠军杯淘汰赛阶段");

const cupRows = queryD1<MatchRow>(
  `SELECT id, round, slot, leg, status, score_home, score_away, home_entry_id, away_entry_id
     FROM match WHERE stage_id = ${cup.id} ORDER BY round, slot, leg`,
  remote
);
const cfg = JSON.parse(cup.config_json || "{}") as Record<string, unknown>;
const finalRound = Math.max(...cupRows.map((r) => r.round));
const extraFinals = cupRows.filter((r) => r.round === finalRound && (r.leg ?? 0) >= 2);

if (extraFinals.length === 0 && cfg.final_legs === 1) {
  notes.push(`冠军杯决赛已是单回合（stage ${cup.id}），跳过`);
} else {
  for (const m of extraFinals) assertClean(m, "冠军杯决赛多余 leg");
  const next = JSON.stringify({ ...cfg, final_legs: 1 });
  statements.push(
    `UPDATE stage SET config_json = '${next.replace(/'/g, "''")}' WHERE id = ${cup.id}`
  );
  if (extraFinals.length > 0) {
    statements.push(
      `DELETE FROM match WHERE id IN (${extraFinals.map((m) => m.id).join(",")})`
    );
  }
  notes.push(
    `冠军杯（stage ${cup.id}）：config 写入 final_legs=1${extraFinals.length ? `，删除决赛多余场次 ${extraFinals.map((m) => m.id).join(", ")}` : ""}`
  );
}

// ---------- 2. 次级附加赛双回合 ----------
const playoff = stages.find((s) => s.tournament_name.includes("次级联赛"));
if (!playoff) throw new Error("没找到次级附加赛阶段");

const pCfg = JSON.parse(playoff.config_json || "{}") as { legs?: number };
const legs = pCfg.legs === 2 ? 2 : 1;
const pRows = queryD1<MatchRow>(
  `SELECT id, round, slot, leg, status, score_home, score_away, home_entry_id, away_entry_id
     FROM match WHERE stage_id = ${playoff.id} ORDER BY round, slot, leg`,
  remote
);

if (legs === 1) {
  notes.push(`次级附加赛配置为单回合（stage ${playoff.id}），跳过`);
} else {
  const groups = new Map<string, MatchRow[]>();
  for (const r of pRows) {
    const key = `${r.round}-${r.slot}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rows] of groups) {
    const [round, slot] = key.split("-").map(Number);
    const present = new Set(rows.map((r) => r.leg));
    // 旧数据：单行且 leg 为空 → 认作 leg1
    const legacy = rows.length === 1 && rows[0].leg === null ? rows[0] : null;
    if (legacy) {
      assertClean(legacy, "次级附加赛补 leg");
      statements.push(`UPDATE match SET leg = 1 WHERE id = ${legacy.id}`);
      present.delete(null);
      present.add(1);
      notes.push(`次级附加赛 r${round}s${slot}：match ${legacy.id} leg NULL → 1`);
    }
    for (let leg = 1; leg <= legs; leg++) {
      if (present.has(leg)) continue;
      statements.push(
        `INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, status) VALUES (${playoff.id}, ${round}, ${slot}, ${leg}, NULL, NULL, 'pending')`
      );
      notes.push(`次级附加赛 r${round}s${slot}：补建 leg ${leg}`);
    }
  }
  if (groups.size === 0) notes.push(`次级附加赛（stage ${playoff.id}）还没有首轮落位，跳过`);
}

// ---------- 执行 ----------
console.log(`目标：${remote ? "线上" : "本地"}${commit ? "（commit）" : "（dry-run）"}`);
for (const n of notes) console.log(`  · ${n}`);

if (statements.length === 0) {
  console.log("无需变更");
  process.exit(0);
}
if (!commit) {
  console.log(`\n将执行 ${statements.length} 条语句：`);
  for (const s of statements) console.log(`  ${s}`);
  process.exit(0);
}

execD1(statements.join(";\n") + ";", remote);

// ---------- 回查 ----------
const cupAfter = queryD1<{ round: number; leg: number | null; n: number }>(
  `SELECT round, leg, count(*) AS n FROM match WHERE stage_id = ${cup.id} GROUP BY round, leg ORDER BY round, leg`,
  remote
);
const pAfter = queryD1<{ round: number; slot: number; leg: number | null }>(
  `SELECT round, slot, leg FROM match WHERE stage_id = ${playoff.id} ORDER BY round, slot, leg`,
  remote
);
console.log("\n冠军杯淘汰赛轮次分布：", cupAfter.map((r) => `r${r.round}/leg${r.leg}:${r.n}`).join("  "));
console.log("次级附加赛：", pAfter.map((r) => `r${r.round}s${r.slot}/leg${r.leg}`).join("  "));
