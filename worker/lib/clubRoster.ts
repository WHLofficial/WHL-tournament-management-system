// v4.0.0 步骤 10：赛事系统从俱乐部平台拉取一线队名册（单向拉模式，俱乐部平台是唯一真源）。
//
// 为什么是「拉」而不是「推」：赛事系统只读俱乐部平台，反过来俱乐部平台完全不需要知道赛事系统的
// 存在，也就不必在俱乐部平台里放第二个系统的写入凭据。拉的一方负责对账，边界最干净。
//
// v5.0.0 的边界调整（上面这段原文保留，改动在此声明）：这条「只拉不推」的规矩对**名册**依然
// 成立，但对「球队建档」破了一个口子——建档是一次性事件、两侧管理端都可能先发起，纯拉取要等
// 1 小时 cron，且本仓读不到俱乐部平台库、反向拉不出「俱乐部有而赛事无」。所以建档走对称的
// `POST /api/internal/team-upsert`（见 worker/lib/clubSync.ts）；名册一行都不推。
//
// 对账语义（squads 是俱乐部平台的一线队全量快照，v5.5 起归属写进 player_team_history）：
// - club 有 / tour 无 → INSERT player + 开一条开放窗口
// - 两队不同 / 本仓没有开放窗口 → 同一 batch 里先关旧窗、再开新窗（球员转会）
// - 姓名、号码一律以 club 为准 → UPDATE
// - club 无 / tour 有（且开放窗口挂在对账范围内的队里）→ **关窗，不删人**；
//   历史比赛事件、伤停登记原样保留，离队球员从名单里消失只是因为没了开放窗口
//
// 三条防御（这是个会改归属的定时任务，宁可少做也不做错）：
// ① club 平台回 0 支球队 → 整体跳过，一条都不动（空快照多半是对方挂了或配置写错）；
// ② 响应形状不对 → 抛错不写库（形状坏掉会让「club 无」对每一行都为真 ⇒ 误关全队窗口）；
// ③ 只对「club 平台名下出现过的队」做关窗，其他队（手工建的队）一行不碰。
// 另加骤降防护：某队一次消失 ≥5 人且占比 ≥50% 时跳过该队关窗（除非 force），
// 防止俱乐部平台半截快照把整队关空。
import type { Bindings } from "../env";
import { metaSyncLog, syncPlayerMeta } from "./clubMeta";

export interface ClubSquadPlayer {
  fcId: number;
  name: string;
  number: string | null;
}

export interface ClubSquad {
  clubId: number;
  clubName: string;
  players: ClubSquadPlayer[];
}

export interface SyncSummary {
  dryRun: boolean;
  /** 参与对账的队数（俱乐部平台回的队）与球员总数 */
  teams: number;
  desired: number;
  inserted: number;
  teamMoved: number;
  renamed: number;
  renumbered: number;
  /** 开放窗口挂在对账队、但快照里没有的人（计划关窗数；dryRun 时就是「会关这么多」） */
  stale: number;
  /** 关掉的窗口数（换队 + 离队；dryRun 时为计划数） */
  closed: number;
  /** 新开的窗口数（新增 + 换队；dryRun 时为计划数） */
  opened: number;
  /** 因快照缺失而关窗的离队人数（dryRun 时为计划数） */
  departed: number;
  /** 骤降防护跳过的队（缺席人数 / 该队开放窗口数） */
  skippedTeams: { teamId: number; absent: number; open: number }[];
  /** 兼容旧字段：关窗语义下恒 0 / 空数组，保留一版给旧客户端与审计读 */
  deleted: number;
  kept: { id: number; name: string; reason: string }[];
  /** 改名样例（最多 20 条）：首次同步要看「名字一批被改写」是否符合预期 */
  renamedSample: { id: number; from: string; to: string }[];
  /** club 平台有、本仓 team 表没有的队：整体跳过（队还没建过来） */
  unknownTeams: number[];
  /** 整体跳过时的原因（此时除 teams/desired 外所有计数为 0） */
  skipped?: string;
}

/** 同步结果（touchedPlayerIds 只给 cron/路由内部用，绝不写进 API 响应） */
export interface SyncResult extends SyncSummary {
  touchedPlayerIds: number[];
}

const SAMPLE_CAP = 20;
/** D1 一次 batch 塞太多语句会撞请求体上限；对账语句彼此独立，分批没有原子性要求 */
const BATCH_CHUNK = 100;

function numberText(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** 拉取超时：这是无人值守的定时任务，对方挂住时必须变成一条可观察的失败分支 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 拉取并**校验**俱乐部平台的一线队快照；形状不对一律抛错，绝不把半截数据当快照用。
 *
 * 「快照里出现过的队至少有一名一线队球员」是硬契约：删除的判据是「在 scopedTeamIds 里、
 * 且快照没提到」，所以一个空名单的队会把它整队镜像删光，而防御①（squads.length === 0）
 * 只数队数、挡不住它。宁可整轮不跑也不误删。
 */
export async function fetchClubSquads(
  base: string,
  opts: { timeoutMs?: number } = {}
): Promise<ClubSquad[]> {
  const url = `${base.replace(/\/+$/, "")}/api/squads`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} 返回 ${res.status}`);
  const body = (await res.json()) as { squads?: unknown };
  if (!Array.isArray(body.squads)) throw new Error(`GET ${url} 响应里没有 squads 数组`);

  return body.squads.map((raw, i) => {
    const s = raw as { clubId?: unknown; clubName?: unknown; players?: unknown };
    if (typeof s.clubId !== "number" || !Number.isInteger(s.clubId)) {
      throw new Error(`俱乐部平台第 ${i + 1} 支球队缺 clubId`);
    }
    if (!Array.isArray(s.players)) {
      throw new Error(`俱乐部平台球队 ${s.clubId} 缺 players 数组`);
    }
    if (s.players.length === 0) {
      throw new Error(`俱乐部平台球队 ${s.clubId} 的名单是空的，快照不可信`);
    }
    const players: ClubSquadPlayer[] = s.players.map((raw2, j) => {
      const p = raw2 as { fcId?: unknown; name?: unknown; number?: unknown };
      if (typeof p.fcId !== "number" || !Number.isInteger(p.fcId)) {
        throw new Error(`俱乐部平台球队 ${s.clubId} 第 ${j + 1} 名球员缺 fcId`);
      }
      if (typeof p.name !== "string" || p.name.trim() === "") {
        throw new Error(`俱乐部平台球队 ${s.clubId} 第 ${j + 1} 名球员缺姓名`);
      }
      return { fcId: p.fcId, name: p.name, number: numberText(p.number) };
    });
    return {
      clubId: s.clubId,
      clubName: typeof s.clubName === "string" ? s.clubName : String(s.clubId),
      players,
    };
  });
}

/** 把快照对账进本仓 player / player_team_history。dryRun=true 时只算不写，用来上线前核对预期。 */
export async function syncRosters(
  db: D1Database,
  squads: ClubSquad[],
  opts: { dryRun?: boolean; force?: boolean } = {}
): Promise<SyncResult> {
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const out: SyncResult = {
    dryRun,
    teams: squads.length,
    desired: 0,
    inserted: 0,
    teamMoved: 0,
    renamed: 0,
    renumbered: 0,
    stale: 0,
    closed: 0,
    opened: 0,
    departed: 0,
    skippedTeams: [],
    deleted: 0,
    kept: [],
    renamedSample: [],
    unknownTeams: [],
    touchedPlayerIds: [],
  };
  if (squads.length === 0) {
    return { ...out, skipped: "俱乐部平台回了 0 支球队，按防御策略不动库" };
  }

  // 队还没建到本仓的，整体跳过：否则 INSERT 会撞 team_id 外键、把整批插入一起打回。
  // （v4.0.0 时这里写的是「理论上不该有，队是在本仓先建再镜像过去的」——那个假设不成立：
  // 当时本仓→俱乐部平台根本没有写入通道，俱乐部平台侧的队可以是先在那边建的。v5.0.0 补上了
  // 双向建档，这条路径才真正常态为空；防御逻辑本身不变。）
  const teamRows = await db.prepare("SELECT id FROM team").all<{ id: number }>();
  const knownTeams = new Set(teamRows.results.map((r) => r.id));
  const scoped = squads.filter((s) => knownTeams.has(s.clubId));
  out.unknownTeams = squads.filter((s) => !knownTeams.has(s.clubId)).map((s) => s.clubId);
  if (scoped.length === 0) {
    return { ...out, skipped: "俱乐部平台回的队在本仓一支都没有，按防御策略不动库" };
  }

  const desired = new Map<number, { teamId: number; name: string; number: string | null }>();
  const observedAnywhere = new Set<number>();
  for (const s of squads) {
    for (const p of s.players) {
      observedAnywhere.add(p.fcId);
      if (!knownTeams.has(s.clubId)) continue; // 未知队只用于「这个人还在别处见过」
      if (desired.has(p.fcId)) {
        // 同一个人出现在两队里 ⇒ 快照本身矛盾，别拿它去改库
        throw new Error(`球员 ${p.fcId} 同时出现在多支球队里，名册快照不可信`);
      }
      // 号码在这里再归一化一次：fetchClubSquads 已经做过，但 syncRosters 也是导出函数，
      // 少归一化一层就会把空串当成「和 null 不一样」从而每次同步都白改一次号
      desired.set(p.fcId, { teamId: s.clubId, name: p.name, number: numberText(p.number) });
    }
  }
  out.desired = desired.size;

  // 全表读（player + 开放窗口）：对账要覆盖「已换到别队的人」与「已离队的人」，
  // 按 open_team_id 过滤会漏掉前者，一次读比按 id 分批 IN 更省也更简单。
  // 一人至多一条开放窗口（partial unique index），所以这里不会出现一行 player 变多行。
  const rows = await db.prepare(
    `SELECT p.id, p.name, p.number, h.team_id AS open_team_id
     FROM player p
     LEFT JOIN player_team_history h ON h.player_id = p.id AND h.left_at IS NULL`
  ).all<{
    id: number;
    name: string;
    number: string | null;
    open_team_id: number | null;
  }>();
  const scopedTeamIds = new Set(scoped.map((s) => s.clubId));
  const byId = new Map(rows.results.map((r) => [r.id, r]));

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const touched = new Set<number>();
  for (const [fcId, want] of desired) {
    const cur = byId.get(fcId);
    if (!cur) {
      stmts.push(
        db
          .prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)")
          .bind(fcId, want.teamId, want.name, want.number)
      );
      stmts.push(
        db
          .prepare(
            "INSERT INTO player_team_history (player_id, team_id, joined_at, source) VALUES (?, ?, ?, 'sync')"
          )
          .bind(fcId, want.teamId, now)
      );
      out.inserted += 1;
      out.opened += 1;
      touched.add(fcId);
      continue;
    }
    const moved = cur.open_team_id !== want.teamId;
    const renamed = cur.name !== want.name;
    const renumbered = numberText(cur.number) !== want.number;
    if (!moved && !renamed && !renumbered) continue;
    touched.add(fcId);
    if (moved) {
      stmts.push(
        db
          .prepare("UPDATE player_team_history SET left_at = ? WHERE player_id = ? AND left_at IS NULL")
          .bind(now, fcId)
      );
      stmts.push(
        db
          .prepare(
            "INSERT INTO player_team_history (player_id, team_id, joined_at, source) VALUES (?, ?, ?, 'sync')"
          )
          .bind(fcId, want.teamId, now)
      );
      out.teamMoved += 1;
      out.closed += 1;
      out.opened += 1;
    }
    stmts.push(
      db
        .prepare("UPDATE player SET name = ?, number = ?, team_id = ? WHERE id = ?")
        .bind(want.name, want.number, want.teamId, fcId)
    );
    if (renamed) {
      out.renamed += 1;
      if (out.renamedSample.length < SAMPLE_CAP) {
        out.renamedSample.push({ id: fcId, from: cur.name, to: want.name });
      }
    }
    if (renumbered) out.renumbered += 1;
  }

  // 对账范围内的队里，快照没提到的人 = 已经不在这个俱乐部了 → 关窗（不删人）。
  // observedAnywhere 含未知队：人只是换到了还没建档的队，等那支队建过来再迁，先别关。
  const stale = rows.results.filter(
    (r) => r.open_team_id != null && scopedTeamIds.has(r.open_team_id) && !observedAnywhere.has(r.id)
  );
  out.stale = stale.length;
  const openCount = new Map<number, number>();
  for (const r of rows.results) {
    if (r.open_team_id != null && scopedTeamIds.has(r.open_team_id)) {
      openCount.set(r.open_team_id, (openCount.get(r.open_team_id) ?? 0) + 1);
    }
  }
  const absentByTeam = new Map<number, number>();
  for (const r of stale) {
    absentByTeam.set(r.open_team_id!, (absentByTeam.get(r.open_team_id!) ?? 0) + 1);
  }
  for (const [teamId, absent] of absentByTeam) {
    const open = openCount.get(teamId) ?? 0;
    // 骤降防护：一次消失过半且至少 5 人，多半是快照半截/配置指错队，宁可这轮不关
    if (!force && absent >= 5 && awayRatio(absent, open) >= 0.5) {
      out.skippedTeams.push({ teamId, absent, open });
      continue;
    }
    for (const r of stale) {
      if (r.open_team_id !== teamId) continue;
      stmts.push(
        db
          .prepare("UPDATE player_team_history SET left_at = ? WHERE player_id = ? AND left_at IS NULL")
          .bind(now, r.id)
      );
      out.closed += 1;
      out.departed += 1;
      touched.add(r.id);
    }
  }

  if (dryRun) return { ...out, touchedPlayerIds: [...touched] };

  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    await db.batch(stmts.slice(i, i + BATCH_CHUNK));
  }
  // deleted/kept 保留为兼容字段：关窗语义下一个人都不删，历史事件与伤停登记原样保留
  return { ...out, touchedPlayerIds: [...touched] };
}

/** 缺席占比（避免在被 0 除时返回 NaN） */
function awayRatio(absent: number, open: number): number {
  return open > 0 ? absent / open : 0;
}

/** 一轮名册同步的结果：ok=false 时调用方不得据此做履历回填（库可能没写成） */
export interface RosterSyncRun {
  ok: boolean;
  summary: SyncResult | null;
  touchedPlayerIds: number[];
}

/** 定时任务入口：配置缺失或拉取失败只记日志不抛，别把一次网络抖动记成 cron 失败 */
export async function runRosterSync(env: Bindings): Promise<RosterSyncRun> {
  const base = env.CLUB_API_BASE;
  if (!base) {
    console.log("[sync-rosters] 未配置 CLUB_API_BASE，跳过");
    return { ok: false, summary: null, touchedPlayerIds: [] };
  }
  try {
    const squads = await fetchClubSquads(base);
    const s = await syncRosters(env.DB, squads);
    console.log(
      `[sync-rosters] 队 ${s.teams} / 快照 ${s.desired} 人：新增 ${s.inserted}、换队 ${s.teamMoved}、` +
        `改名 ${s.renamed}、改号 ${s.renumbered}、关窗 ${s.closed}（离队 ${s.departed}）、` +
        `开窗 ${s.opened}、计划关窗 ${s.stale}` +
        (s.skippedTeams.length ? `、骤降跳过 ${s.skippedTeams.length} 队` : "") +
        (s.skipped ? `（跳过：${s.skipped}）` : "")
    );
    // 名册对账完再补球员元数据（FC26 属性 / 徽章 / 身高，见 clubMeta.ts）。
    // meta 是附加展示数据：这里再兜一层，任何意外都只记日志，绝不让名册同步看起来失败。
    try {
      const fcIds = squads.flatMap((sq) => sq.players.map((p) => p.fcId));
      console.log(metaSyncLog(await syncPlayerMeta(env, fcIds)));
    } catch (e) {
      console.error(
        `[sync-player-meta] 意外失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
    return { ok: true, summary: s, touchedPlayerIds: s.touchedPlayerIds };
  } catch (e) {
    console.error(`[sync-rosters] 失败：${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, summary: null, touchedPlayerIds: [] };
  }
}
