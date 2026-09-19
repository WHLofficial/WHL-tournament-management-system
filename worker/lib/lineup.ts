// 战术阵容提交：存储解析、提交校验、DTO 组装。
// coach（提交/回显）、public（开赛后公开）、admin（赛前备案）三个端点共用，保证口径一致。
import {
  ASSIGN_GROUPS,
  assignConflicts,
  conflictText,
  FORMS,
  isAssignKey,
} from "../../shared/tactics";
import type { AssignKey } from "../../shared/tactics";
import { loadPlayerMeta } from "./playerMeta";
import type {
  LineupAssignDTO,
  LineupBenchDTO,
  LineupStarterDTO,
  MatchLineupDTO,
  PlayerMeta,
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

// ── 球员指派（FC26 Assignments）────────────────────────────────────────────

export type AssignMap = Partial<Record<AssignKey, number>>;

// assign_json → 「角色码 → 球员 id」。库里的 JSON 是自己写入的，防御性过滤：坏项丢弃不炸接口。
export function parseAssignJson(json: string): AssignMap {
  let v: unknown;
  try {
    v = JSON.parse(json || "{}");
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: AssignMap = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isAssignKey(k)) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) continue;
    out[k] = raw;
  }
  return out;
}

// 校验提交载荷里的指派：白名单键 + 正整数 + 无互斥冲突。
// 缺省/null 视为空 = 本次不带指派（提交是整份覆盖：阵容与指派一起被替换掉）。
// 存档（tactic）只走这一步：存档是跨场草稿本，允许在代打模式下存目标队的人，
// 所以不做球员归属校验；提交阵容必须再走 validateAssign。
export function normalizeAssign(raw: unknown): AssignMap {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new LineupError(400, "队长与定位球的格式不对，请回战术板重填");
  }
  const assign: AssignMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAssignKey(k)) throw new LineupError(400, "队长与定位球里有不认识的项目，请回战术板重填");
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new LineupError(400, "队长与定位球里有坏掉的项目，请回战术板重选球员");
    }
    assign[k] = v;
  }
  const conflicts = assignConflicts(assign);
  if (conflicts.length) {
    throw new LineupError(400, `队长与定位球有冲突：${conflictText(conflicts[0])}`);
  }
  return assign;
}

// 提交阵容用的指派校验：在 normalizeAssign 之上再要求球员属于 teamId 那支队。
// teamId 由调用方显式传入——本队提交传本队，代打提交必须传被代打队的 grant.teamId，
// 否则代打者按自己的队判会把合法提交判成 400。
export async function validateAssign(
  db: D1Database,
  teamId: number,
  raw: unknown,
): Promise<AssignMap> {
  const assign = normalizeAssign(raw);
  const ids = [...new Set(Object.values(assign))];
  if (ids.length) {
    const owned = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM player WHERE team_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(teamId, ...ids)
      .first<{ n: number }>();
    if (owned?.n !== ids.length) {
      throw new LineupError(400, "队长与定位球里点到了不属于该球队的球员，请回战术板重选");
    }
  }
  return assign;
}

// 「角色码 → 球员 id」→ 按 ASSIGN_GROUPS 顺序的 DTO 列表（队长在最前，组内按表内顺序）。
// 姓名/号码取自调用方的球员批量查询；starter 由本场首发 playerId 集合判定
// （false = 该球员已不在本场首发，保留不静默清空，前端标黄提示）。
export function resolveAssign(
  assign: AssignMap,
  players: Map<number, { name: string; number: string | null }>,
  starterPids: Set<number>,
  meta: Map<number, PlayerMeta>,
): LineupAssignDTO[] {
  const out: LineupAssignDTO[] = [];
  for (const g of ASSIGN_GROUPS) {
    for (const item of g.items) {
      const pid = assign[item.key];
      if (pid === undefined) continue;
      const p = players.get(pid);
      const m = meta.get(pid);
      out.push({
        key: item.key,
        playerId: pid,
        name: p?.name ?? null,
        number: p?.number ?? null,
        starter: starterPids.has(pid),
        ...(m ? { meta: m } : {}),
      });
    }
  }
  return out;
}

export interface WriteLineupParams {
  matchId: number;
  teamId: number;
  userId: number;
  form: string;
  slots: StoredLineupSlot[];
  code: string;
  /** 球员指派：角色码 → 球员 id。空对象 = 本次不带指派（会覆盖清空） */
  assign: Record<string, number>;
  /** 非空 = 这份阵容是经该代打授权提交的（留痕列）。本队教练自己交时留空 */
  proxyGrantId?: number | null;
}

// 阵容写入口。一赛一队一份，重复提交覆盖（开赛前允许反复改）。
// 返回语句而非直接执行：代打路径要把审计并入同一批，保证留痕与写入同生共死。
export function writeLineupStmt(db: D1Database, p: WriteLineupParams): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tactic_submission (match_id, team_id, created_by, form, slots_json, code, assign_json, proxy_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, team_id) DO UPDATE SET
         created_by = excluded.created_by,
         form = excluded.form,
         slots_json = excluded.slots_json,
         code = excluded.code,
         assign_json = excluded.assign_json,
         proxy_grant_id = excluded.proxy_grant_id,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(
      p.matchId,
      p.teamId,
      p.userId,
      p.form,
      JSON.stringify(p.slots),
      p.code,
      JSON.stringify(p.assign ?? {}),
      p.proxyGrantId ?? null,
    );
}

export async function writeLineup(db: D1Database, p: WriteLineupParams): Promise<void> {
  await writeLineupStmt(db, p).run();
}

type SubRow = {
  id: number;
  team_id: number;
  form: string;
  slots_json: string;
  assign_json: string;
  created_at: string;
  team_name: string | null;
  submitted_by: string | null;
  proxy_grant_id: number | null;
};

async function buildTeamLineup(
  db: D1Database,
  row: SubRow,
  withAssign = true,
): Promise<TeamLineupDTO> {
  const slots = parseSlotsJson(row.slots_json);
  // 不回指派时连解析都省掉：公开端只看首发、替补和阵型
  const assign = withAssign ? parseAssignJson(row.assign_json) : {};
  // 指派指向的球员可能已不在首发（甚至已不在名单），所以 id 集合要把指派项一并算上
  const ids = [
    ...new Set([...slots.map((s) => s.player_id), ...Object.values(assign)]),
  ];
  const players = new Map<number, { name: string; number: string | null }>();
  if (ids.length) {
    const rs = await db
      .prepare(`SELECT id, name, number FROM player WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: number; name: string; number: string | null }>();
    for (const p of rs.results ?? []) players.set(p.id, { name: p.name, number: p.number });
  }
  const meta = await loadPlayerMeta(db, ids);
  const starters: LineupStarterDTO[] = [];
  const bench: LineupBenchDTO[] = [];
  for (const s of slots) {
    const p = players.get(s.player_id);
    const m = meta.get(s.player_id);
    const base = {
      playerId: s.player_id,
      name: p?.name ?? null,
      number: p?.number ?? null,
      ...(m ? { meta: m } : {}),
    };
    if ("kind" in s) {
      bench.push({ kind: "bench", ...base });
    } else {
      starters.push({
        kind: "starter",
        lid: s.lid,
        position: s.position,
        ...base,
      });
    }
  }
  starters.sort((a, b) => a.lid - b.lid);
  const starterPids = new Set(starters.map((s) => s.playerId));
  return {
    teamId: row.team_id,
    teamName: row.team_name ?? "",
    form: row.form,
    submittedAt: row.created_at,
    submittedBy: row.submitted_by,
    viaProxy: row.proxy_grant_id != null,
    starters,
    bench,
    assign: withAssign ? resolveAssign(assign, players, starterPids, meta) : [],
  };
}

// 一场比赛双方提交的阵容。requireStarted=true（公开接口）时比赛未开打或赛事还在草稿，
// 一律返回双方 null——赛前不亮牌是产品决策；管理员端传 false 备案可见。
// withAssign=false 时不回「队长与定位球」：那属于战术隐私，公开端只给首发、替补和阵型。
export async function fetchMatchLineup(
  db: D1Database,
  matchId: number,
  requireStarted: boolean,
  withAssign = true,
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
      `SELECT ts.id, ts.team_id, ts.form, ts.slots_json, ts.assign_json, ts.created_at,
         u.name AS submitted_by, te.name AS team_name, ts.proxy_grant_id
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
  // 双方阵容构建互不依赖，并行发
  const [home, away] = await Promise.all([
    homeRow ? buildTeamLineup(db, homeRow, withAssign) : Promise.resolve(null),
    awayRow ? buildTeamLineup(db, awayRow, withAssign) : Promise.resolve(null),
  ]);
  return { home, away };
}
