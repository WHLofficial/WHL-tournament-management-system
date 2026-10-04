// 淘汰赛手动落位的布局纯函数（不碰业务读模型，只产出 D1 语句）：
// 首轮场次由管理员点选落位，后续轮次铺空壳，胜者仍由 worker/lib/standings.ts 的晋级器回填。
// 布局键（round/slot/leg/note）与 worker/lib/seeding.ts 的 buildElimPlan 保持一致，
// 差异只在「首轮从 entryCount 推 vs 从已有首轮场次数 N 推」——两者等价：size = 2N。

import type { PlanMatch } from "./seeding";

export type ManualCfg = { legs: 1 | 2; finalLegs?: 1 | 2; thirdPlace: boolean };

export type ManualRow = {
  id: number;
  round: number;
  slot: number;
  leg: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
  winner_entry_id: number | null;
  status: string;
  note: string | null;
};

export type Round1Slot = { slot: number; home: number | null; away: number | null };

export type SlotRowValue = {
  leg: number | null;
  home: number | null;
  away: number | null;
  winner: number | null;
  note: string | null;
};

export const MAX_FIRST_ROUND = 16;

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
}

// 首轮 N 场（N = 2^k，即 2N 支球队的淘汰赛）→ 总轮数 = k + 1。
// N=1（2 队直接决赛）→ 1 轮，该场就是决赛；N=4 → 3 轮。非 2 的幂返回 0（不铺后续轮次）。
export function roundsFor(firstRoundCount: number): number {
  if (!isPowerOfTwo(firstRoundCount)) return 0;
  return Math.log2(firstRoundCount) + 1;
}

// 决赛轮（含季军赛）回合数独立配置，缺省跟随 legs —— 与 buildElimPlan 同一条规则。
export function legsOfRound(cfg: ManualCfg, round: number, rounds: number): 1 | 2 {
  return round === rounds ? (cfg.finalLegs ?? cfg.legs) : cfg.legs;
}

// 后续轮次（round ≥ 2）的空壳布局；季军赛与决赛同轮、排在 slot 2。
export function layoutShells(firstRoundCount: number, cfg: ManualCfg): PlanMatch[] {
  const rounds = roundsFor(firstRoundCount);
  if (rounds === 0) return [];
  const size = firstRoundCount * 2;
  const shells: PlanMatch[] = [];
  for (let r = 2; r <= rounds; r++) {
    const slots = size / 2 ** r;
    for (let j = 0; j < slots; j++) {
      if (legsOfRound(cfg, r, rounds) === 2) {
        shells.push({ round: r, slot: j + 1, leg: 1, home: null, away: null });
        shells.push({ round: r, slot: j + 1, leg: 2, home: null, away: null });
      } else {
        shells.push({ round: r, slot: j + 1, home: null, away: null });
      }
    }
  }
  if (cfg.thirdPlace && rounds >= 2) {
    const thirdSlot = size / 2 ** rounds + 1;
    if (legsOfRound(cfg, rounds, rounds) === 2) {
      shells.push({ round: rounds, slot: thirdSlot, leg: 1, home: null, away: null, note: "季军赛" });
      shells.push({ round: rounds, slot: thirdSlot, leg: 2, home: null, away: null, note: "季军赛" });
    } else {
      shells.push({ round: rounds, slot: thirdSlot, home: null, away: null, note: "季军赛" });
    }
  }
  return shells;
}

// 单个首轮场次应有的行：轮空 = 单行（away=null、winner 预填、note='轮空'，供晋级器识别）；
// 两回合 = 两行（leg2 主客对调）；空场次 = 单行空壳。
export function slotRows(
  home: number | null,
  away: number | null,
  legs: 1 | 2
): SlotRowValue[] {
  if (home != null && away == null) {
    return [{ leg: null, home, away: null, winner: home, note: "轮空" }];
  }
  if (home == null && away == null) {
    return [{ leg: null, home: null, away: null, winner: null, note: null }];
  }
  if (legs === 2) {
    return [
      { leg: 1, home, away, winner: null, note: null },
      { leg: 2, home: away, away: home, winner: null, note: null },
    ];
  }
  return [{ leg: null, home, away, winner: null, note: null }];
}

export function groupBySlot(rows: ManualRow[], round: number): Map<number, ManualRow[]> {
  const map = new Map<number, ManualRow[]>();
  for (const r of rows) {
    if (r.round !== round) continue;
    const list = map.get(r.slot);
    if (list) list.push(r);
    else map.set(r.slot, [r]);
  }
  return map;
}

// 首轮各场次的落位（按 slot 升序）；镜像行（leg2）不参与读值。
export function round1Placements(rows: ManualRow[]): Round1Slot[] {
  const out: Round1Slot[] = [];
  for (const [slot, group] of groupBySlot(rows, 1)) {
    const first = group.find((r) => r.leg !== 2) ?? group[0];
    out.push({ slot, home: first.home_entry_id, away: first.away_entry_id });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

export function firstRoundCount(rows: ManualRow[]): number {
  const slots = round1Placements(rows);
  return slots.length;
}

// 首轮场次数不是 2 的幂时（含 0 场）的统一拒绝文案：开打闸门与结构操作共用一句。
export function firstRoundSizeError(rows: ManualRow[]): string | null {
  const n = firstRoundCount(rows);
  if (isPowerOfTwo(n)) return null;
  return `首轮场次数需为 2 的幂（当前 ${n} 场），请先在赛程页增删场次`;
}

// 现有行与应有行是否逐键一致（leg/home/away/winner/note）。
export function slotRowMismatch(existing: ManualRow[], desired: SlotRowValue[]): boolean {
  const key = (r: SlotRowValue) =>
    `${r.leg ?? ""}:${r.home ?? ""}:${r.away ?? ""}:${r.winner ?? ""}:${r.note ?? ""}`;
  const rowKey = (r: ManualRow) =>
    `${r.leg ?? ""}:${r.home_entry_id ?? ""}:${r.away_entry_id ?? ""}:${r.winner_entry_id ?? ""}:${r.note ?? ""}`;
  if (existing.length !== desired.length) return true;
  const a = existing.map(rowKey).sort();
  const b = desired.map(key).sort();
  return a.some((v, i) => v !== b[i]);
}

// 后续轮次空壳的对齐：以期望布局做差量——
// 键（round/slot/leg/note）一致的行走 UPDATE 原地重置，清掉可能过期的晋级预填
// （首轮落位变化后由晋级器重算）；只对多出/缺失的键增删行，保留其它场次的 match.id。
export function shellStmts(
  db: D1Database,
  stageId: number,
  firstRoundCountValue: number,
  cfg: ManualCfg,
  rows: ManualRow[]
): D1PreparedStatement[] {
  const keyOf = (round: number, slot: number, leg: number | null, note: string | null) =>
    `${round}:${slot}:${leg ?? 0}:${note ?? ""}`;
  const want = new Map<string, PlanMatch>();
  for (const pm of layoutShells(firstRoundCountValue, cfg)) {
    want.set(keyOf(pm.round, pm.slot, pm.leg ?? null, pm.note ?? null), pm);
  }
  const have = new Map<string, ManualRow>();
  for (const r of rows) {
    if (r.round < 2) continue;
    have.set(keyOf(r.round, r.slot, r.leg, r.note), r);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const [k, r] of have) {
    // 已开打/完赛的行一律不删不重置（端点已在结构变化前挡住这种状态）
    if (r.status !== "pending") continue;
    if (!want.has(k)) stmts.push(db.prepare("DELETE FROM match WHERE id = ?").bind(r.id));
  }
  for (const [k, pm] of want) {
    const ex = have.get(k);
    if (!ex) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, status, note)
             VALUES (?, ?, ?, ?, NULL, NULL, 'pending', ?)`
          )
          .bind(stageId, pm.round, pm.slot, pm.leg ?? null, pm.note ?? null)
      );
      continue;
    }
    if (
      ex.status === "pending" &&
      (ex.home_entry_id != null || ex.away_entry_id != null || ex.winner_entry_id != null)
    ) {
      stmts.push(
        db
          .prepare(
            "UPDATE match SET home_entry_id = NULL, away_entry_id = NULL, winner_entry_id = NULL WHERE id = ?"
          )
          .bind(ex.id)
      );
    }
  }
  return stmts;
}

// 首轮行对齐：把库里的首轮行改成 desired 的落位。
// 行形状不变（leg 键一致）时走 UPDATE，保住 match.id 与挂在其上的战术提交；
// 只有形状真的变了（回合制 1↔2、轮空↔对阵）才删旧插新。desired 里没有的场次整场删除。
// 注意：existing 传的是「虚拟变更后」的行（slot 可被端点重编号），id 必须是库里的真实 id。
export function relayRound1Stmts(
  db: D1Database,
  stageId: number,
  legs: 1 | 2,
  desired: Round1Slot[],
  existing: ManualRow[]
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const slot of desired) {
    const want = slotRows(slot.home, slot.away, legs);
    const have = existing
      .filter((r) => r.round === 1 && r.slot === slot.slot)
      .sort((a, b) => (a.leg ?? 0) - (b.leg ?? 0));
    if (have.length === 0) {
      stmts.push(...insertSlotRows(db, stageId, slot.slot, slot.home, slot.away, legs));
      continue;
    }
    // 该场次已开打/完赛则原样保留（端点已在落位前挡住这种状态）
    if (have.some((r) => r.status !== "pending")) continue;
    if (!slotRowMismatch(have, want)) continue;
    const sameShape =
      have.length === want.length && have.every((r, i) => (r.leg ?? 0) === (want[i].leg ?? 0));
    if (sameShape) {
      for (let i = 0; i < have.length; i++) {
        stmts.push(
          db
            .prepare(
              `UPDATE match SET home_entry_id = ?, away_entry_id = ?, winner_entry_id = ?, note = ?
               WHERE id = ?`
            )
            .bind(want[i].home, want[i].away, want[i].winner, want[i].note, have[i].id)
        );
      }
      continue;
    }
    stmts.push(
      db.prepare("DELETE FROM match WHERE stage_id = ? AND round = 1 AND slot = ?").bind(stageId, slot.slot)
    );
    stmts.push(...insertSlotRows(db, stageId, slot.slot, slot.home, slot.away, legs));
  }
  const keep = new Set(desired.map((d) => d.slot));
  for (const slot of round1Placements(existing)) {
    if (keep.has(slot.slot)) continue;
    const rows = existing.filter((r) => r.round === 1 && r.slot === slot.slot);
    if (rows.some((r) => r.status !== "pending")) continue;
    stmts.push(
      db.prepare("DELETE FROM match WHERE stage_id = ? AND round = 1 AND slot = ?").bind(stageId, slot.slot)
    );
  }
  return stmts;
}

export function insertSlotRows(
  db: D1Database,
  stageId: number,
  slot: number,
  home: number | null,
  away: number | null,
  legs: 1 | 2
): D1PreparedStatement[] {
  return slotRows(home, away, legs).map((v) =>
    db
      .prepare(
        `INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id,
                            status, winner_entry_id, note)
         VALUES (?, 1, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(stageId, slot, v.leg, v.home, v.away, v.winner, v.note)
  );
}

// 结构变化（增/删场次、落位、清空）后的统一收口：对齐后续轮空壳 + 重铺首轮行。
// 调用方随后必须补跑一次幂等晋级器（buildAdvanceStmts）——轮空的晋级/回滚都靠它。
// desired = 变更后的首轮落位（增：多一项空场次；删：去掉一项且后续序号前移）。
export function rebuildStmts(
  db: D1Database,
  stageId: number,
  firstRoundCountValue: number,
  cfg: ManualCfg,
  desired: Round1Slot[],
  rows: ManualRow[]
): D1PreparedStatement[] {
  const rounds = roundsFor(firstRoundCountValue);
  const legs = rounds === 0 ? cfg.legs : legsOfRound(cfg, 1, rounds);
  return [
    ...shellStmts(db, stageId, firstRoundCountValue, cfg, rows),
    ...relayRound1Stmts(db, stageId, legs, desired, rows),
  ];
}
