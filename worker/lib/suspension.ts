// 停赛规则引擎：纯派生，不落库。
// 从 match_event（yellow / red / red_2y）+ match 比赛序列实时推导每个球员的
// 停赛剩余场次与黄牌累积；删事件、改判、补录后下次计算自动生效，无反冲逻辑。
// 口径：直红停 redBan 场；两黄变一红停 red2yBan 场；累积 yellowThreshold 张黄牌停 1 场
// 并重新计数；红牌与黄牌停赛并行叠加；pending 场不消耗停赛（live/finished 消耗）；
// 轮空场不算比赛；有 yellowResetAt 清零锚点时按事件时间拆两段重放：
// 锚点前完整重放（清零前已生效停赛继续执行），锚点后黄牌从零重计，补录按 created_at 归段。
import type { SuspensionConfig, SuspensionStatusDTO } from "../../shared/types";
import { buildToplists, type Toplists } from "./topstats";

export const DEFAULT_SUSPENSION: SuspensionConfig = {
  redBan: 2,
  red2yBan: 1,
  yellowThreshold: 3,
  yellowResetAt: null,
};

const clampBan = (v: unknown, fallback: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : fallback;
};

// 读赛事停赛配置；缺省/坏值回退默认（照 getTiebreakers 模式）
export async function getSuspensionConfig(
  db: D1Database,
  tid: number
): Promise<SuspensionConfig> {
  const fallback = { ...DEFAULT_SUSPENSION };
  const t = await db
    .prepare("SELECT config_json FROM tournament WHERE id = ?")
    .bind(tid)
    .first<{ config_json: string | null }>();
  if (!t) return fallback;
  let cfg: { suspension?: Partial<SuspensionConfig> } = {};
  try {
    cfg = (JSON.parse(t.config_json || "{}") ?? {}) as { suspension?: Partial<SuspensionConfig> };
  } catch {
    return fallback;
  }
  const s = cfg.suspension ?? {};
  return {
    redBan: clampBan(s.redBan, DEFAULT_SUSPENSION.redBan),
    red2yBan: clampBan(s.red2yBan, DEFAULT_SUSPENSION.red2yBan),
    yellowThreshold: clampBan(s.yellowThreshold, DEFAULT_SUSPENSION.yellowThreshold),
    yellowResetAt: typeof s.yellowResetAt === "string" ? s.yellowResetAt : null,
  };
}

// PUT 保存时的校验归一；yellowResetAt 不在此列，只能由 reset-yellows 端点写入
export function normalizeSuspensionInput(
  input: unknown
): { redBan: number; red2yBan: number; yellowThreshold: number } | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const vals = [o.redBan, o.red2yBan, o.yellowThreshold].map((v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
  });
  if (vals.some((v) => v === null)) return null;
  return {
    redBan: vals[0] as number,
    red2yBan: vals[1] as number,
    yellowThreshold: vals[2] as number,
  };
}

interface MatchSeqRow {
  id: number;
  home_entry_id: number | null;
  away_entry_id: number | null;
  status: "pending" | "live" | "finished";
  note: string | null;
  stage_order: number;
  round: number;
  slot: number;
  leg: number | null;
}

interface DisciplineRow {
  id: number;
  match_id: number;
  entry_id: number;
  player_id: number;
  type: "yellow" | "red" | "red_2y";
  created_at: string;
  player_name: string;
  team_id: number;
  team_name: string;
}

interface Ban {
  from: number; // 生效起点 = 触发场在该队比赛序列中的下一场下标
  remaining: number;
  fresh: boolean; // 本次重放新触发的 ban（接力的旧 ban 不再消耗，避免双遍重复扣减）
}

interface PlayerInfo {
  playerName: string;
  teamId: number;
  teamName: string;
  entryId: number;
  byMatch: Map<number, DisciplineRow[]>;
}

// 单遍重放：按该队比赛序处理 pass 选中的纪律事件。bansIn 接力既有处罚；
// consumeIn=false 时接力 ban 不参与消耗（锚点前段已扣完），只消耗本次新触发的。
function replay(
  info: PlayerInfo,
  seq: MatchSeqRow[],
  bansIn: Ban[],
  consumeIn: boolean,
  pass: (ev: DisciplineRow) => boolean,
  cfg: SuspensionConfig
): { bans: Ban[]; yellowCount: number } {
  const bans: Ban[] = bansIn.map((b) => ({ ...b, fresh: false }));
  let yellowCount = 0;
  for (let i = 0; i < seq.length; i++) {
    const m = seq[i];
    // 先消耗后触发：同一场既可以是旧处罚的消耗场，也可以是新处罚的触发场
    if (m.status !== "pending") {
      for (const b of bans) {
        if ((b.fresh || consumeIn) && b.from <= i && b.remaining > 0) b.remaining -= 1;
      }
    }
    const evs = info.byMatch.get(m.id);
    if (!evs) continue;
    // 两黄变一红同场的黄牌不计入停赛累积（该球员该场只记 1 红）
    const sentOff2y = evs.some((x) => x.type === "red_2y");
    for (const ev of evs) {
      if (!pass(ev)) continue;
      if (ev.type === "yellow") {
        if (sentOff2y) continue;
        yellowCount += 1;
        if (cfg.yellowThreshold > 0 && yellowCount >= cfg.yellowThreshold) {
          bans.push({ from: i + 1, remaining: 1, fresh: true });
          yellowCount = 0;
        }
      } else if (ev.type === "red") {
        bans.push({ from: i + 1, remaining: cfg.redBan, fresh: true });
      } else {
        bans.push({ from: i + 1, remaining: cfg.red2yBan, fresh: true });
      }
    }
  }
  return { bans, yellowCount };
}

// 计算单赛事内所有有红黄牌记录球员的停赛状态。
// 有清零锚点时拆两遍：锚点前事件完整重放（清零前已生效的停赛定格后继续执行），
// 锚点后事件黄牌从零重计；补录旧比赛的事件按 created_at 归段，不污染新累积。
export async function computeSuspensions(
  db: D1Database,
  tid: number,
  cfg: SuspensionConfig
): Promise<SuspensionStatusDTO[]> {
  const [matches, events] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, m.home_entry_id, m.away_entry_id, m.status, m.note,
                s.sort_order AS stage_order, m.round, m.slot, m.leg
         FROM match m
         JOIN stage s ON s.id = m.stage_id
         WHERE s.tournament_id = ?
         ORDER BY s.sort_order, m.round, m.slot, m.leg, m.id`
      )
      .bind(tid)
      .all<MatchSeqRow>(),
    db
      .prepare(
        `SELECT me.id, me.match_id, me.entry_id, me.player_id, me.type, me.created_at,
                p.name AS player_name, t.id AS team_id, t.name AS team_name
         FROM match_event me
         JOIN match m ON m.id = me.match_id
         JOIN stage s ON s.id = m.stage_id
         JOIN entry e ON e.id = me.entry_id
         JOIN team t ON t.id = e.team_id
         JOIN player p ON p.id = me.player_id
         WHERE s.tournament_id = ? AND me.player_id IS NOT NULL
           AND me.type IN ('yellow', 'red', 'red_2y')
         ORDER BY me.id`
      )
      .bind(tid)
      .all<DisciplineRow>(),
  ]);

  // 每支参赛队的比赛序列（排除轮空场——没打的比赛不消耗停赛）
  const byEntry = new Map<number, MatchSeqRow[]>();
  for (const m of matches.results ?? []) {
    if (m.note === "轮空") continue;
    for (const eid of [m.home_entry_id, m.away_entry_id]) {
      if (eid == null) continue;
      const list = byEntry.get(eid);
      if (list) list.push(m);
      else byEntry.set(eid, [m]);
    }
  }

  // 每球员的纪律事件，按其所属球队的比赛序列下标归位
  const byPlayer = new Map<number, PlayerInfo>();
  for (const ev of events.results ?? []) {
    let info = byPlayer.get(ev.player_id);
    if (!info) {
      info = {
        playerName: ev.player_name,
        teamId: ev.team_id,
        teamName: ev.team_name,
        entryId: ev.entry_id,
        byMatch: new Map(),
      };
      byPlayer.set(ev.player_id, info);
    }
    const list = info.byMatch.get(ev.match_id);
    if (list) list.push(ev);
    else info.byMatch.set(ev.match_id, [ev]);
  }

  const out: SuspensionStatusDTO[] = [];
  const hasAnchor = cfg.yellowResetAt !== null;
  const resetAt = cfg.yellowResetAt ?? "";
  for (const [playerId, info] of byPlayer) {
    const seq = byEntry.get(info.entryId);
    if (!seq) continue;
    // 锚点前段：完整重放历史触发，清零前已生效的停赛定格在 bans 里继续执行
    const pass1 = replay(info, seq, [], true, (ev) => !hasAnchor || ev.created_at <= resetAt, cfg);
    // 锚点后段：黄牌从零重计（锚点后没有新事件时自然为 0），接力 bans 不重复消耗
    const final = hasAnchor
      ? replay(info, seq, pass1.bans, false, (ev) => ev.created_at > resetAt, cfg)
      : pass1;
    const remaining = final.bans.reduce((sum, b) => sum + b.remaining, 0);
    out.push({
      playerId,
      playerName: info.playerName,
      teamId: info.teamId,
      teamName: info.teamName,
      entryId: info.entryId,
      remaining,
      yellows: final.yellowCount,
    });
  }
  out.sort(
    (a, b) =>
      b.remaining - a.remaining ||
      b.yellows - a.yellows ||
      a.playerName.localeCompare(b.playerName, "zh")
  );
  return out;
}

// 榜单 + 停赛标记：公开端与管理端 toplists 共用
export async function buildToplistsWithSuspension(
  db: D1Database,
  tid: number
): Promise<Toplists> {
  const [cfg, lists] = await Promise.all([getSuspensionConfig(db, tid), buildToplists(db, tid)]);
  const susp = await computeSuspensions(db, tid, cfg);
  const off = new Set(susp.filter((s) => s.remaining > 0).map((s) => s.playerId));
  return {
    ...lists,
    cardsPlayers: lists.cardsPlayers.map((r) => ({ ...r, suspended: off.has(r.playerId) })),
  };
}
