import { Hono } from "hono";
import type { AppEnv } from "../env";
import { rateLimit } from "../lib/ratelimit";
import {
  fetchMatchLineup,
  LineupError,
  normalizeAssign,
  parseAssignJson,
  validateAssign,
  validateLineupSlots,
  writeLineup,
  writeLineupStmt,
} from "../lib/lineup";
import { AuthApiError, authBindTeam, boundAccounts, boundTeamId, teamMembers } from "../lib/authClient";
import { requirePermission, requirePwChanged } from "../middleware/auth";
import { computeSuspensions, parseSuspensionConfig } from "../lib/suspension";
import { listActiveInjuries } from "../lib/injury";
import { auditStmt } from "../lib/audit";
import { accountNames, findGrantForGrantee, findGrantForTeam, getGranteeSession, listGranteeSessions } from "../lib/lineupProxy";
import { BUILDUPS, FORMS, decodeFut25, decodeFut26 } from "../../shared/tactics";
import type {
  CoachStatusPlayerDTO,
  CoachStatusResp,
  LineupSubmitBody,
  ProxyBoardResp,
  TacticArchiveDTO,
} from "../../shared/types";

// 教练侧：凭认证码绑定球队 + 我的球队。一账号一队；解绑只走管理员接口。
// 增量 7：绑定真源在 auth 库（team_binding），本仓只读派生（AUTH_DB）。
const app = new Hono<AppEnv>();

// 教练侧全部端点旧判定 = 仅登录 + 未锁定（观众号也持 tour.team.bind，锁定在 /bind 内拦截）
app.use("*", requirePermission("tour.team.bind", "user"));
app.use("*", requirePwChanged);

app.post("/bind", async (c) => {
  const user = c.get("user")!;
  // 观众号锁定：放限流前，不烧失败次数
  if (user.locked) {
    return c.json({ message: "你的账号暂不能绑定球队，请联系管理员解锁" }, 403);
  }
  // 按 IP 限尝试次数：10 分钟窗口 5 次（正常输入一次就成功，够防爆破）
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const ok = await rateLimit(c.env, `bindfail:${ip}`, 5, 600);
  if (!ok) {
    return c.json({ message: "尝试太频繁，请 10 分钟后再来" }, 429);
  }

  const body = await c.req.json<{ code?: string }>().catch(() => null);
  const code = body?.code?.trim().toUpperCase();
  if (!code || code.length !== 8) {
    return c.json({ message: "认证码格式不对，应为 8 位字母数字" }, 400);
  }

  // 增量 7：绑定真源在 auth（team_binding），烧码经机器通道写认证中心；
  // 一次性码、一账号一队并发闸、审计全在 auth 单事务内完成。
  try {
    const { teamId } = await authBindTeam(c.env, { code, accountId: user.id, via: "tour" });
    return c.json({ ok: true, teamId });
  } catch (e) {
    if (e instanceof AuthApiError) {
      if (e.code === "invalid_code") return c.json({ message: "认证码无效或已过期" }, 400);
      if (e.code === "already_bound") return c.json({ message: "该账号已经绑定了球队，解绑需联系管理员" }, 409);
      return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
    }
    throw e;
  }
});

// 本队名单（抽成函数供 /me/team 与教练首屏聚合 /bootstrap 共用）
async function buildMeTeam(env: AppEnv["Bindings"], tm: number) {
  const team = await env.DB.prepare("SELECT id, name FROM team WHERE id = ?")
    .bind(tm)
    .first<{ id: number; name: string }>();
  const [players, members, entries] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, number FROM player WHERE team_id = ?
       ORDER BY (number IS NULL), CAST(number AS INTEGER), number, id`
    )
      .bind(tm)
      .all<{ id: number; name: string; number: string | null }>(),
    teamMembers(env, tm),
    env.DB.prepare(
      `SELECT e.id, t.name AS tournament_name, t.status, g.name AS group_name, e.seed
       FROM entry e
       JOIN tournament t ON t.id = e.tournament_id
       LEFT JOIN "group" g ON g.id = e.group_id
       WHERE e.team_id = ? ORDER BY t.created_at DESC`
    )
      .bind(tm)
      .all<{
        id: number;
        tournament_name: string;
        status: string;
        group_name: string | null;
        seed: number;
      }>(),
  ]);
  return {
    id: team?.id ?? tm,
    name: team?.name ?? "",
    players: players.results.map((p) => ({
      id: p.id,
      name: p.name,
      number: p.number,
    })),
    members: members.map((m) => ({
      id: m.userId,
      name: m.name,
      joinedAt: m.joinedAt,
    })),
    entries: entries.results.map((e) => ({
      id: e.id,
      tournamentName: e.tournament_name,
      status: e.status,
      groupName: e.group_name,
      seed: e.seed,
    })),
  };
}

// 我的球队（未绑定时 team 为 null）
app.get("/me/team", async (c) => {
  const user = c.get("user")!;
  const tm = await boundTeamId(c.env, user.id);
  if (!tm) return c.json({ team: null });
  return c.json({ team: await buildMeTeam(c.env, tm) });
});

// 教练侧写入口约定：阵容提交是唯一的教练写赛事数据端点（一赛一队一份，重复提交覆盖）。
// 可见性：赛前仅管理员可见（备案）；开赛（live）后公开。教练回显只看得到自己那份，看不到对手的。

async function teamIdOf(env: AppEnv["Bindings"], userId: number): Promise<number | null> {
  return boundTeamId(env, userId);
}

// 导出给 tests/d1-read-plan.test.ts 跑 EXPLAIN QUERY PLAN 用
export const COACH_ME_MATCHES_SQL = `SELECT m.id, m.round, m.leg, m.note,
       t.id AS tournament_id, t.name AS tournament_name,
       s.name AS stage_name, s.kind AS stage_kind,
       he.team_id AS home_tid, ae.team_id AS away_tid,
       ht.name AS home_team_name, at.name AS away_team_name,
       ts.id AS sub_id, g.id AS grant_id
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN team at ON at.id = ae.team_id
     LEFT JOIN tactic_submission ts ON ts.match_id = m.id AND ts.team_id = ?
     LEFT JOIN lineup_proxy_grant g ON g.id = (SELECT MIN(g2.id) FROM lineup_proxy_grant g2
       WHERE g2.match_id = m.id AND g2.team_id = ? AND g2.revoked_at IS NULL)
     WHERE m.status = 'pending' AND t.status != 'draft'
       AND (m.note IS NULL OR m.note != '轮空')
       AND (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?)
            OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = ?))
     ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot`;

// 本队待开的比赛（抽成函数供 /me/matches 与教练首屏聚合 /bootstrap 共用）
async function buildMeMatches(db: D1Database, teamId: number) {
  const rows = await db
    .prepare(COACH_ME_MATCHES_SQL)
    .bind(teamId, teamId, teamId, teamId)
    .all<{
      id: number;
      round: number;
      leg: number | null;
      tournament_id: number;
      tournament_name: string;
      stage_name: string | null;
      stage_kind: "elim" | "round_robin" | "group";
      home_tid: number | null;
      away_tid: number | null;
      home_team_name: string | null;
      away_team_name: string | null;
      sub_id: number | null;
      grant_id: number | null;
    }>();
  return (rows.results ?? []).map((r) => {
    const side: "home" | "away" = r.home_tid === teamId ? "home" : "away";
    return {
      id: r.id,
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      stageName: r.stage_name,
      stageKind: r.stage_kind,
      round: r.round,
      leg: r.leg,
      side,
      opponentName: side === "home" ? r.away_team_name : r.home_team_name,
      submitted: r.sub_id !== null,
      // 本场本队的阵容已授权别人代打：本队教练此时交不了，板上要说清缘由
      proxyGranted: r.grant_id !== null,
    };
  });
}

// 本队待开的比赛：选一场提交阵容用。轮空场排除（没有对阵意义）
app.get("/me/matches", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env, user.id);
  if (!teamId) return c.json({ matches: [] });
  return c.json({ matches: await buildMeMatches(c.env.DB, teamId) });
});

// 某队在某赛事下的停赛清单（口径与录入端一致）。战术板的「本队状态」与代打板都要用，
// 唯一差别只是传进来的 teamId 是谁，故抽出来共用。
async function suspensionSliceOf(
  db: D1Database,
  teamId: number,
  tid: number,
  configJson: string | null,
): Promise<{ yellowThreshold: number; players: CoachStatusPlayerDTO[] }> {
  const cfg = parseSuspensionConfig(configJson);
  // 只重放本队：多队赛事里别队的牌与本队口径无关
  const all = await computeSuspensions(db, tid, cfg, teamId);
  const players = all
    .filter((p) => p.teamId === teamId && (p.remaining > 0 || p.yellows > 0))
    .map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      remaining: p.remaining,
      yellows: p.yellows,
    }))
    .sort((a, b) => b.remaining - a.remaining || b.yellows - a.yellows || a.playerId - b.playerId);
  return { yellowThreshold: cfg.yellowThreshold, players };
}

// 本队伤停/停赛概览：战术板上的状态提示（只读；全部只提示不拦截）。
// 停赛按赛事算（红黄牌在赛事内独立累计，故板上要能切赛事）；伤停跨赛事，不随赛事变。
// 导出给 tests/d1-read-plan.test.ts 跑 EXPLAIN QUERY PLAN 用
export const COACH_DEFAULT_TOURNAMENT_SQL = `SELECT t.id AS tournament_id
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       LEFT JOIN entry he ON he.id = m.home_entry_id
       LEFT JOIN entry ae ON ae.id = m.away_entry_id
       WHERE m.status = 'pending' AND t.status != 'draft'
         AND (m.note IS NULL OR m.note != '轮空')
         AND (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?)
              OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = ?))
       ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot LIMIT 1`;

app.get("/me/status", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env, user.id);
  const empty: CoachStatusResp = {
    tournaments: [],
    tournamentId: null,
    yellowThreshold: 0,
    players: [],
    injuries: [],
  };
  if (!teamId) return c.json(empty);

  // 本队可看的赛事（已报名、且赛事已发布，草稿不暴露）、默认赛事、本队伤停三者的 SQL 互不依赖，
  // 一批并行取；config_json 顺带查出，省掉单独读停赛口径的那次往返。
  const [rows, next, injuries] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id AS tournament_id, t.name, t.config_json
       FROM entry e JOIN tournament t ON t.id = e.tournament_id
       WHERE e.team_id = ? AND t.status != 'draft'
       ORDER BY t.created_at DESC, t.id DESC`,
    )
      .bind(teamId)
      .all<{ tournament_id: number; name: string; config_json: string | null }>(),
    // 默认赛事：本队最近一场待开比赛所在赛事（口径同 /me/matches）；没有待开比赛就取最新赛事
    c.env.DB.prepare(COACH_DEFAULT_TOURNAMENT_SQL)
      .bind(teamId, teamId)
      .first<{ tournament_id: number }>(),
    listActiveInjuries(c.env.DB, teamId),
  ]);
  const rowsAll = rows.results ?? [];
  const tournaments = rowsAll.map((r) => ({ tournamentId: r.tournament_id, name: r.name }));
  const defTid = next?.tournament_id ?? tournaments[0]?.tournamentId ?? null;
  const list = tournaments.map((t) => ({ ...t, default: t.tournamentId === defTid }));

  // 传入的赛事不属于本队就静默回落默认（教练手改 URL 也不该看到别队赛事）
  const want = Number(c.req.query("tournamentId"));
  const tid = list.some((t) => t.tournamentId === want) ? want : defTid;
  if (tid == null) return c.json({ ...empty, tournaments: list, injuries });

  const cfgJson = rowsAll.find((r) => r.tournament_id === tid)?.config_json ?? null;
  const slice = await suspensionSliceOf(c.env.DB, teamId, tid, cfgJson);

  const resp: CoachStatusResp = {
    tournaments: list,
    tournamentId: tid,
    yellowThreshold: slice.yellowThreshold,
    players: slice.players,
    injuries,
  };
  return c.json(resp);
});

// 我在某场比赛已提交的阵容（提交面板回显；只回自己那份，对手的赛前看不到）
app.get("/matches/:mid/lineup", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env, user.id);
  if (!teamId) return c.json({ lineup: null });
  const mid = Number(c.req.param("mid"));
  let lineup;
  try {
    lineup = await fetchMatchLineup(c.env.DB, mid, false);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }
  const mine =
    lineup.home?.teamId === teamId ? lineup.home : lineup.away?.teamId === teamId ? lineup.away : null;
  return c.json({ lineup: mine });
});

// 提交/覆盖阵容：比赛须属于本队且未开打；球员必须都在本队名单里
app.put("/matches/:mid/lineup", async (c) => {
  const user = c.get("user")!;
  if (user.locked) return c.json({ message: "你的账号暂不能提交阵容，请联系管理员解锁" }, 403);
  const teamId = await teamIdOf(c.env, user.id);
  if (!teamId) return c.json({ message: "请先绑定球队再提交阵容" }, 403);
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `tsub:${ip}:${user.id}`, 10, 60))) {
    return c.json({ message: "提交太频繁，请一分钟后再试" }, 429);
  }

  const body = await c.req.json<LineupSubmitBody>().catch(() => null);
  if (!body || typeof body.form !== "string" || !Array.isArray(body.slots)) {
    return c.json({ message: "请求格式不对" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().slice(0, 512) : "";
  let slots;
  try {
    slots = validateLineupSlots(body.form, body.slots);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }

  const mid = Number(c.req.param("mid"));
  const m = await c.env.DB.prepare(
    `SELECT m.status, he.team_id AS home_tid, ae.team_id AS away_tid
     FROM match m
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     WHERE m.id = ?`,
  )
    .bind(mid)
    .first<{
      status: "pending" | "live" | "finished";
      home_tid: number | null;
      away_tid: number | null;
    }>();
  if (!m || (m.home_tid !== teamId && m.away_tid !== teamId)) {
    return c.json({ message: "比赛不存在或不属于你的球队" }, 404);
  }
  if (m.status !== "pending") {
    return c.json({ message: "比赛已开打，阵容已锁定" }, 409);
  }
  // 本场本队的阵容已授权别人代打时，本队教练让位（撤销后立刻恢复）
  const ceded = await findGrantForTeam(c.env.DB, mid, teamId);
  if (ceded && ceded.granteeUserId !== user.id) {
    return c.json({ message: "本场阵容已授权他人代打，你暂不能提交" }, 403);
  }

  const ids = [...new Set(slots.map((s) => s.player_id))];
  const owned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM player WHERE team_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(teamId, ...ids)
    .first<{ n: number }>();
  if (owned?.n !== ids.length) {
    return c.json({ message: "名单里有不属于你球队的球员，请回战术板重选" }, 400);
  }
  let assign;
  try {
    assign = await validateAssign(c.env.DB, teamId, body.assign);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }

  await writeLineup(c.env.DB, {
    matchId: mid,
    teamId,
    userId: user.id,
    form: body.form,
    slots,
    code,
    assign,
  });
  return c.json({ ok: true });
});

// —— 阵容代打：管理员把「某场某队的阵容提交权」临时授给别的教练（migration 0023）——

// 我在哪些场次被授权代打。开赛或撤销后自动从清单里消失，前端据此显示身份切换器。
app.get("/proxy/sessions", async (c) => {
  const user = c.get("user")!;
  const acct = accountNames(await boundAccounts(c.env));
  const sessions = await listGranteeSessions(c.env.DB, user.id, acct);
  return c.json({ sessions });
});

// 教练首屏聚合端点（增量 39）：战术板首屏原本 4 个 effect 各发一次请求
// （本队名单 / 战术存档 / 待选比赛 / 代打授权），四段的队伍归属与账号名取自同一组 auth 查询，
// 合成一个端点后这几跳只算一次，前端首屏请求从 4 降到 1。
// 段间口径与 /me/team、/tactics、/me/matches、/proxy/sessions 完全一致（共用同一批构造器，不重抄）。
app.get("/bootstrap", async (c) => {
  const user = c.get("user")!;
  const [tm, acct] = await Promise.all([
    boundTeamId(c.env, user.id),
    boundAccounts(c.env).then(accountNames),
  ]);
  const [team, tactics, matches, sessions] = await Promise.all([
    tm ? buildMeTeam(c.env, tm) : Promise.resolve(null),
    tm ? buildTactics(c.env.DB, tm) : Promise.resolve([]),
    tm ? buildMeMatches(c.env.DB, tm) : Promise.resolve([]),
    listGranteeSessions(c.env.DB, user.id, acct),
  ]);
  return c.json({ team, tactics, matches, sessions });
});

// 代打板取数：目标队的名单、伤停、停赛与已提交阵容一次取全（口径与 /me/team、/me/status 完全一致，
// 只把 teamId 换成被代打的那支队，这样战术板的校验与提示无需另写一套）
app.get("/proxy/:mid/board", async (c) => {
  const user = c.get("user")!;
  const mid = Number(c.req.param("mid"));
  if (!Number.isInteger(mid)) return c.json({ message: "比赛不存在" }, 404);

  const acct = accountNames(await boundAccounts(c.env));
  const session = await getGranteeSession(c.env.DB, mid, user.id, acct);
  if (!session) return c.json({ message: "这场没有你的代打授权" }, 403);

  const [players, injuries, lineup, slice] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, name, number FROM player WHERE team_id = ?
       ORDER BY (number IS NULL), CAST(number AS INTEGER), number, id`,
    )
      .bind(session.teamId)
      .all<{ id: number; name: string; number: string | null }>(),
    listActiveInjuries(c.env.DB, session.teamId),
    fetchMatchLineup(c.env.DB, mid, false),
    (async () => {
      const t = await c.env.DB.prepare("SELECT config_json FROM tournament WHERE id = ?")
        .bind(session.tournamentId)
        .first<{ config_json: string | null }>();
      return suspensionSliceOf(c.env.DB, session.teamId, session.tournamentId, t?.config_json ?? null);
    })(),
  ]);

  const mine =
    lineup.home?.teamId === session.teamId
      ? lineup.home
      : lineup.away?.teamId === session.teamId
        ? lineup.away
        : null;
  const status: CoachStatusResp = {
    // 赛事被授权锁死在这一场，选择器只留这一个，避免板上切赛事切了个寂寞
    tournaments: [{ tournamentId: session.tournamentId, name: session.tournamentName, default: true }],
    tournamentId: session.tournamentId,
    yellowThreshold: slice.yellowThreshold,
    players: slice.players,
    injuries,
  };
  const body: ProxyBoardResp = {
    session,
    players: players.results.map((p) => ({ id: p.id, name: p.name, number: p.number })),
    status,
    lineup: mine,
  };
  return c.json(body);
});

// 代打提交：替被代打队交本场阵容。写 proxy_grant_id 留痕，审计与写入同一批。
app.put("/proxy/:mid/lineup", async (c) => {
  const user = c.get("user")!;
  if (user.locked) return c.json({ message: "你的账号暂不能提交阵容，请联系管理员解锁" }, 403);
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `tsub:${ip}:${user.id}`, 10, 60))) {
    return c.json({ message: "提交太频繁，请一分钟后再试" }, 429);
  }

  const mid = Number(c.req.param("mid"));
  if (!Number.isInteger(mid)) return c.json({ message: "比赛不存在" }, 404);
  // 授权先于报文校验：没这份授权，报文再规范也无权交
  const grant = await findGrantForGrantee(c.env.DB, mid, user.id);
  if (!grant) return c.json({ message: "这场没有你的代打授权" }, 403);

  const body = await c.req.json<LineupSubmitBody>().catch(() => null);
  if (!body || typeof body.form !== "string" || !Array.isArray(body.slots)) {
    return c.json({ message: "请求格式不对" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().slice(0, 512) : "";
  let slots;
  try {
    slots = validateLineupSlots(body.form, body.slots);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }

  // 球员归属按被代打队判：代打者交的必须是目标队的在册球员
  const ids = [...new Set(slots.map((s) => s.player_id))];
  const owned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM player WHERE team_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(grant.teamId, ...ids)
    .first<{ n: number }>();
  if (owned?.n !== ids.length) {
    return c.json({ message: "名单里有不属于该球队的球员，请回战术板重选" }, 400);
  }
  // 指派按被代打队判（不是代打者自己的队），否则合法提交会被判 400
  let assign;
  try {
    assign = await validateAssign(c.env.DB, grant.teamId, body.assign);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }

  await c.env.DB.batch([
    writeLineupStmt(c.env.DB, {
      matchId: mid,
      teamId: grant.teamId,
      userId: user.id,
      form: body.form,
      slots,
      code,
      assign,
      proxyGrantId: grant.id,
    }),
    auditStmt(c.env.DB, user.id, "lineup_proxy_submit", mid, {
      teamId: grant.teamId,
      grantId: grant.id,
    }),
  ]);
  return c.json({ ok: true });
});

// —— 战术存档：tactic 表（团队共享，单队上限 20 条）。存当前战术码 + 人员分配映射，载入整板回填 ——

const TACTIC_CAP = 20;

function parseRoster(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k.slice(0, 8)] = val.slice(0, 32);
    }
    return out;
  } catch {
    return {};
  }
}

// 战术存档列表（抽成函数供 /tactics 与教练首屏聚合 /bootstrap 共用）
async function buildTactics(db: D1Database, teamId: number): Promise<TacticArchiveDTO[]> {
  const rows = await db
    .prepare(
      `SELECT id, code, form, buildup, line_height, note, roster_json, assign_json, created_at
     FROM tactic WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT ${TACTIC_CAP}`,
    )
    .bind(teamId)
    .all<{
      id: number;
      code: string;
      form: string;
      buildup: string;
      line_height: number;
      note: string | null;
      roster_json: string;
      assign_json: string;
      created_at: string;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    code: r.code,
    form: r.form,
    buildup: r.buildup,
    lineHeight: r.line_height,
    note: r.note ?? "",
    roster: parseRoster(r.roster_json),
    assign: parseAssignJson(r.assign_json),
    createdAt: r.created_at,
  }));
}

app.get("/tactics", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env, user.id);
  if (!teamId) return c.json({ tactics: [] });
  return c.json({ tactics: await buildTactics(c.env.DB, teamId) });
});

app.post("/tactics", async (c) => {
  const user = c.get("user")!;
  if (user.locked) return c.json({ message: "你的账号暂不能存档，请联系管理员解锁" }, 403);
  const teamId = await teamIdOf(c.env, user.id);
  if (!teamId) return c.json({ message: "请先绑定球队再存档" }, 403);
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `tarc:${ip}:${user.id}`, 10, 60))) {
    return c.json({ message: "操作太频繁，请一分钟后再试" }, 429);
  }

  const body = await c.req
    .json<{
      note?: string;
      code?: string;
      form?: string;
      buildup?: string;
      lineHeight?: number;
      roster?: Record<string, unknown>;
      assign?: Record<string, unknown>;
    }>()
    .catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim().replace(/\s+/g, "") : "";
  if (code.length !== 11 && code.length !== 12) {
    return c.json({ message: "战术码格式不对" }, 400);
  }
  try {
    if (code.length === 12) decodeFut26(code);
    else decodeFut25(code);
  } catch {
    return c.json({ message: "战术码无效，不能存档" }, 400);
  }
  const form = typeof body?.form === "string" ? body.form : "";
  if (!FORMS.some((f) => f.value === form)) {
    return c.json({ message: "阵型不合法" }, 400);
  }
  const buildup = typeof body?.buildup === "string" ? body.buildup : "";
  if (!BUILDUPS.includes(buildup as never)) {
    return c.json({ message: "组织风格不合法" }, 400);
  }
  const lineHeight = Number(body?.lineHeight);
  if (!Number.isInteger(lineHeight) || lineHeight < 1 || lineHeight > 100) {
    return c.json({ message: "防线高度不合法" }, 400);
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 32) : "";
  const rosterIn = body?.roster;
  if (rosterIn !== undefined && (rosterIn === null || typeof rosterIn !== "object" || Array.isArray(rosterIn))) {
    return c.json({ message: "人员分配格式不对" }, 400);
  }
  const roster: Record<string, string> = {};
  if (rosterIn) {
    for (const [k, v] of Object.entries(rosterIn)) {
      if (typeof v === "string" && v) roster[k.slice(0, 8)] = v.slice(0, 32);
      if (Object.keys(roster).length >= 24) break;
    }
  }
  // 指派随存档存一份：跨场复用回填用。存档是草稿本，不做球员归属校验（可存代打目标队的人）
  let assign;
  try {
    assign = normalizeAssign(body?.assign);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }

  const full = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM tactic WHERE team_id = ?")
    .bind(teamId)
    .first<{ n: number }>();
  if ((full?.n ?? 0) >= TACTIC_CAP) {
    return c.json({ message: `存档已满（${TACTIC_CAP} 条），请先删除旧的` }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO tactic (team_id, created_by, code, form, buildup, line_height, note, roster_json, assign_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      teamId,
      user.id,
      code,
      form,
      buildup,
      lineHeight,
      note || null,
      JSON.stringify(roster),
      JSON.stringify(assign),
    )
    .run();
  return c.json({ ok: true });
});

app.delete("/tactics/:id", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env, user.id);
  if (!teamId) return c.json({ message: "请先绑定球队" }, 403);
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare("DELETE FROM tactic WHERE id = ? AND team_id = ?")
    .bind(id, teamId)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return c.json({ message: "存档不存在" }, 404);
  return c.json({ ok: true });
});

export default app;
