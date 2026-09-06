// 战术阵容提交：存储解析、提交校验、DTO 组装。
// coach（提交/回显）、public（开赛后公开）、admin（赛前备案）三个端点共用，保证口径一致。
import { FORMS } from "../../shared/tactics";
import type {
  LineupBenchDTO,
  LineupStarterDTO,
  MatchLineupDTO,
  StoredLineupSlot,
  TeamLineupDTO,
} from "../../shared/types";

export class LineupError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// 库里的 JSON 是自己写入的，但防御性过滤：坏行丢弃，不炸接口
export function parseSlotsJson(json: string): StoredLineupSlot[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: StoredLineupSlot[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const pid = o.player_id;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (o.kind === "bench") {
      out.push({ kind: "bench", player_id: pid });
    } else if (typeof o.lid === "number" && typeof o.position === "string") {
      out.push({ lid: o.lid, position: o.position, player_id: pid });
    }
  }
  return out;
}

// 校验并规范化提交载荷：11 首发（lid/位置与阵型一致）+ 0-9 替补，全队 20 人不重复。
// 返回按 首发阵型位序 + 替补原顺序 排列的规范化 slots；非法抛 LineupError(400)。
export function validateLineupSlots(form: string, raw: unknown): StoredLineupSlot[] {
  const def = FORMS.find((f) => f.value === form);
  if (!def) throw new LineupError(400, "阵型不认识，请回战术板重新选择");
  if (!Array.isArray(raw)) throw new LineupError(400, "请求格式不对");

  const starters = new Map<number, { lid: number; position: string; player_id: number }>();
  const bench: { kind: "bench"; player_id: number }[] = [];
  const seen = new Set<number>();
  for (const s of raw) {
    if (!s || typeof s !== "object") throw new LineupError(400, "请求格式不对");
    const o = s as Record<string, unknown>;
    const pid = o.player_id;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new LineupError(400, "有位置没选球员，请回战术板补齐首发");
    }
    if (seen.has(pid)) throw new LineupError(400, "同一名球员不能又首发又替补");
    if (o.kind === "bench") {
      bench.push({ kind: "bench", player_id: pid });
      seen.add(pid);
      continue;
    }
    const lid = o.lid;
    if (typeof lid !== "number" || !Number.isInteger(lid)) {
      throw new LineupError(400, "首发位置信息不完整，请回战术板重新排阵");
    }
    if (starters.has(lid)) throw new LineupError(400, "首发位置重复，请回战术板检查");
    const slotDef = def.pos.find((p) => p.lid === lid);
    if (!slotDef || o.position !== slotDef.position) {
      throw new LineupError(400, "首发位置和阵型对不上，请回战术板重新排阵");
    }
    starters.set(lid, { lid, position: slotDef.position, player_id: pid });
    seen.add(pid);
  }
  if (starters.size !== 11) {
    throw new LineupError(400, `首发要满 11 人，现在只有 ${starters.size} 人`);
  }
  if (bench.length > 9) throw new LineupError(400, "替补最多 9 人");
  return [...def.pos.map((p) => starters.get(p.lid)!), ...bench];
}

type SubRow = {
  id: number;
  team_id: number;
  form: string;
  slots_json: string;
  created_at: string;
  team_name: string | null;
  submitted_by: string | null;
};

async function buildTeamLineup(db: D1Database, row: SubRow): Promise<TeamLineupDTO> {
  const slots = parseSlotsJson(row.slots_json);
  const ids = [...new Set(slots.map((s) => s.player_id))];
  const players = new Map<number, { name: string; number: string | null }>();
  if (ids.length) {
    const rs = await db
      .prepare(`SELECT id, name, number FROM player WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: number; name: string; number: string | null }>();
    for (const p of rs.results ?? []) players.set(p.id, { name: p.name, number: p.number });
  }
  const starters: LineupStarterDTO[] = [];
  const bench: LineupBenchDTO[] = [];
  for (const s of slots) {
    const p = players.get(s.player_id);
    if ("kind" in s) {
      bench.push({ kind: "bench", playerId: s.player_id, name: p?.name ?? null, number: p?.number ?? null });
    } else {
      starters.push({
        kind: "starter",
        lid: s.lid,
        position: s.position,
        playerId: s.player_id,
        name: p?.name ?? null,
        number: p?.number ?? null,
      });
    }
  }
  starters.sort((a, b) => a.lid - b.lid);
  return {
    teamId: row.team_id,
    teamName: row.team_name ?? "",
    form: row.form,
    submittedAt: row.created_at,
    submittedBy: row.submitted_by,
    starters,
    bench,
  };
}

// 一场比赛双方提交的阵容。requireStarted=true（公开接口）时比赛未开打或赛事还在草稿，
// 一律返回双方 null——赛前不亮牌是产品决策；管理员端传 false 备案可见。
export async function fetchMatchLineup(
  db: D1Database,
  matchId: number,
  requireStarted: boolean,
): Promise<MatchLineupDTO> {
  const m = await db
    .prepare(
      `SELECT m.status, t.status AS tournament_status,
         he.team_id AS home_tid, ae.team_id AS away_tid
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       LEFT JOIN entry he ON he.id = m.home_entry_id
       LEFT JOIN entry ae ON ae.id = m.away_entry_id
       WHERE m.id = ?`,
    )
    .bind(matchId)
    .first<{
      status: "pending" | "live" | "finished";
      tournament_status: string;
      home_tid: number | null;
      away_tid: number | null;
    }>();
  if (!m) throw new LineupError(404, "比赛不存在");
  if (requireStarted && (m.status === "pending" || m.tournament_status === "draft")) {
    return { home: null, away: null };
  }

  const subs = await db
    .prepare(
      `SELECT ts.id, ts.team_id, ts.form, ts.slots_json, ts.created_at,
         u.name AS submitted_by, te.name AS team_name
       FROM tactic_submission ts
       LEFT JOIN user u ON u.id = ts.created_by
       LEFT JOIN team te ON te.id = ts.team_id
       WHERE ts.match_id = ?`,
    )
    .bind(matchId)
    .all<SubRow>();
  const byTeam = new Map<number, SubRow>();
  for (const r of subs.results ?? []) byTeam.set(r.team_id, r);

  const homeRow = m.home_tid != null ? byTeam.get(m.home_tid) : undefined;
  const awayRow = m.away_tid != null ? byTeam.get(m.away_tid) : undefined;
  return {
    home: homeRow ? await buildTeamLineup(db, homeRow) : null,
    away: awayRow ? await buildTeamLineup(db, awayRow) : null,
  };
}
