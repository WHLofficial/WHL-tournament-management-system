// 增量 33 步骤 10：赛事系统从俱乐部平台拉取一线队名册（单向拉模式，俱乐部平台是唯一真源）。
//
// 为什么是「拉」而不是「推」：赛事系统只读俱乐部平台，反过来俱乐部平台完全不需要知道赛事系统的
// 存在，也就不必在俱乐部平台里放第二个系统的写入凭据。拉的一方负责对账，边界最干净。
//
// 对账语义（squads 是俱乐部平台的一线队全量快照）：
// - club 有 / tour 无 → INSERT，**用 fcId 当 player.id**（两库早前一起 rekey 过，
//   赛事系统的 player.id 就是 FC26 playerid）
// - 两队不同 → 改 team_id（球员换队）
// - 姓名、号码一律以 club 为准 → UPDATE
// - club 无 / tour 有（且该行挂在对账范围内的队里）→ DELETE；被外键拦下（有比赛事件引用过）
//   就保留并在响应里点名，绝不为了「同步干净」删掉历史比赛记录
//
// 三条防御（这是个会删数据的定时任务，宁可少做也不做错）：
// ① club 平台回 0 支球队 → 整体跳过，一条都不动（空快照多半是对方挂了或配置写错）；
// ② 响应形状不对 → 抛错不写库（形状坏掉会让「club 无」对每一行都为真 ⇒ 误删全库）；
// ③ 只对「club 平台名下出现过的队」做删除，其他队（手工建的队）一行不碰。
import type { Bindings } from "../env";

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
  /** 计划删除的行数（dryRun 时就是「会删这么多」） */
  stale: number;
  /** 实际删掉的行数；被外键拦下的进 kept */
  deleted: number;
  kept: { id: number; name: string; reason: string }[];
  /** 改名样例（最多 20 条）：首次同步要看「名字一批被改写」是否符合预期 */
  renamedSample: { id: number; from: string; to: string }[];
  /** club 平台有、本仓 team 表没有的队：整体跳过（队还没建过来） */
  unknownTeams: number[];
  /** 整体跳过时的原因（此时除 teams/desired 外所有计数为 0） */
  skipped?: string;
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

/** 拉取并**校验**俱乐部平台的一线队快照；形状不对一律抛错，绝不把半截数据当快照用 */
export async function fetchClubSquads(base: string): Promise<ClubSquad[]> {
  const url = `${base.replace(/\/+$/, "")}/api/squads`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
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

/** 把快照对账进本仓 player 表。dryRun=true 时只算不写，用来上线前核对预期。 */
export async function syncRosters(
  db: D1Database,
  squads: ClubSquad[],
  opts: { dryRun?: boolean } = {}
): Promise<SyncSummary> {
  const dryRun = opts.dryRun === true;
  const out: SyncSummary = {
    dryRun,
    teams: squads.length,
    desired: 0,
    inserted: 0,
    teamMoved: 0,
    renamed: 0,
    renumbered: 0,
    stale: 0,
    deleted: 0,
    kept: [],
    renamedSample: [],
    unknownTeams: [],
  };
  if (squads.length === 0) {
    return { ...out, skipped: "俱乐部平台回了 0 支球队，按防御策略不动库" };
  }

  // 队还没建到本仓的（理论上不该有：队是在本仓先建再镜像过去的）整体跳过，
  // 否则 INSERT 会撞 team_id 外键、把整批插入一起打回
  const teamRows = await db.prepare("SELECT id FROM team").all<{ id: number }>();
  const knownTeams = new Set(teamRows.results.map((r) => r.id));
  const scoped = squads.filter((s) => knownTeams.has(s.clubId));
  out.unknownTeams = squads.filter((s) => !knownTeams.has(s.clubId)).map((s) => s.clubId);
  if (scoped.length === 0) {
    return { ...out, skipped: "俱乐部平台回的队在本仓一支都没有，按防御策略不动库" };
  }

  const desired = new Map<number, { teamId: number; name: string; number: string | null }>();
  for (const s of scoped) {
    for (const p of s.players) {
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

  // 全表读：本仓 player 只有几百行（对账要覆盖「已换到别队的人」与「已离队的人」，
  // 按 team_id 过滤会漏掉前者），一次读比按 id 分批 IN 更省也更简单
  const rows = await db.prepare("SELECT id, team_id, name, number FROM player").all<{
    id: number;
    team_id: number;
    name: string;
    number: string | null;
  }>();
  const scopedTeamIds = new Set(scoped.map((s) => s.clubId));
  const byId = new Map(rows.results.map((r) => [r.id, r]));

  const stmts: D1PreparedStatement[] = [];
  for (const [fcId, want] of desired) {
    const cur = byId.get(fcId);
    if (!cur) {
      stmts.push(
        db
          .prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)")
          .bind(fcId, want.teamId, want.name, want.number)
      );
      out.inserted += 1;
      continue;
    }
    const moved = cur.team_id !== want.teamId;
    const renamed = cur.name !== want.name;
    const renumbered = numberText(cur.number) !== want.number;
    if (!moved && !renamed && !renumbered) continue;
    stmts.push(
      db
        .prepare("UPDATE player SET team_id = ?, name = ?, number = ? WHERE id = ?")
        .bind(want.teamId, want.name, want.number, fcId)
    );
    if (moved) out.teamMoved += 1;
    if (renamed) {
      out.renamed += 1;
      if (out.renamedSample.length < SAMPLE_CAP) {
        out.renamedSample.push({ id: fcId, from: cur.name, to: want.name });
      }
    }
    if (renumbered) out.renumbered += 1;
  }

  // 对账范围内的队里，快照没提到的行 = 已经不在这个俱乐部了
  const stale = rows.results.filter((r) => scopedTeamIds.has(r.team_id) && !desired.has(r.id));
  out.stale = stale.length;

  if (dryRun) return out;

  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    await db.batch(stmts.slice(i, i + BATCH_CHUNK));
  }

  // 删除逐条执行（不能进 batch）：外键拦下一条不该把整批一起回滚，
  // 而且逐条才拿得到「是哪一行被拦下的」这个信息
  for (const r of stale) {
    try {
      await db.prepare("DELETE FROM player WHERE id = ?").bind(r.id).run();
      out.deleted += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.kept.push({
        id: r.id,
        name: r.name,
        reason: /FOREIGN KEY/i.test(msg) ? "有比赛事件/伤停引用，保留" : msg,
      });
    }
  }
  return out;
}

/** 定时任务入口：配置缺失或拉取失败只记日志不抛，别把一次网络抖动记成 cron 失败 */
export async function runRosterSync(env: Bindings): Promise<void> {
  const base = env.CLUB_API_BASE;
  if (!base) {
    console.log("[sync-rosters] 未配置 CLUB_API_BASE，跳过");
    return;
  }
  try {
    const squads = await fetchClubSquads(base);
    const s = await syncRosters(env.DB, squads);
    console.log(
      `[sync-rosters] 队 ${s.teams} / 快照 ${s.desired} 人：新增 ${s.inserted}、换队 ${s.teamMoved}、` +
        `改名 ${s.renamed}、改号 ${s.renumbered}、删除 ${s.deleted}/${s.stale}、保留 ${s.kept.length}` +
        (s.skipped ? `（跳过：${s.skipped}）` : "")
    );
  } catch (e) {
    console.error(`[sync-rosters] 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
