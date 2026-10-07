// 球员元数据（FC26 属性 / 徽章 / 身高）镜像：把俱乐部平台的这份数据落进本仓 player_meta 表
// （表见 migrations/0026_player_meta.sql），供战术页显示候选球员的属性 pill 与徽章 chip。
//
// 为什么镜像而不是每次现拉：真源是俱乐部平台（players.game_attrs 71 键 JSON + player_playstyles
// 明细表），赛事系统的名册本来就是它的镜像（clubRoster 用 fcId 当 player.id），meta 跟着同一条
// 同步节拍落库即可 —— 战术页每开一次就跨仓打一次 club，既慢又把对方的可用性拖进了自己的页面。
//
// 与名册同步的边界（这条线是刻意的）：
// - 名册快照形状坏掉要抛错不写库（clubRoster 的防御②：会误删），meta 坏掉只记日志 —— meta 是
//   纯增量覆盖，没有删除动作，最坏结果是某个人的属性 pill 不显示；
// - 所以本文件里所有网络与解析失败都自己吞掉并计数，唯一对外效果是日志 + MetaSyncSummary；
//   名册同步调用它时**不允许**因为 meta 失败而中断（调用点就是普通 await，函数内部保证不抛）。
import type { Bindings } from "../env";

export interface ClubPlayerMeta {
  fcId: number;
  height: number | null;
  attrs: Record<string, number>;
  playstyles: number[];
}

/** 单批 fcId 个数上限：与俱乐部平台端点约定 90（GET /api/players/meta?fcIds=a,b,c…） */
export const META_BATCH = 90;

/** 拉取超时：无人值守的定时任务，对方挂住必须变成一条可观察的失败分支 */
const FETCH_TIMEOUT_MS = 10_000;

/** D1 一次 batch 塞太多语句会撞请求体上限；upsert 彼此独立，分批没有原子性要求 */
const BATCH_CHUNK = 100;

/**
 * 只认有限数值的属性表（与读侧 worker/lib/playerMeta.ts 同一套过滤规则）：
 * club 侧字段是 JSON，脏值在这里就地丢掉，入库的 JSON 一定是「英文键 → 数值」。
 */
function cleanAttrs(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 徽章 id：正整数，去重排序（顺序稳定，便于比对两次同步的差异） */
function cleanPlaystyles(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * 按 fcId 批量拉元数据。**形状不对就抛**（调用方逐批 try/catch 降级）：
 * - 非 2xx → 抛；
 * - 响应里没有 players 数组 → 抛（半截数据当全量用会把整批球员的元数据一起写坏）；
 * - 单条脏数据（缺 fcId / attrs 不是对象）→ 跳过这一条，不牵连整批。
 * 身高取不到是 null（club 侧口径），不是错误。
 */
export async function fetchPlayerMetaBatch(
  base: string,
  fcIds: number[],
  opts: { timeoutMs?: number } = {}
): Promise<ClubPlayerMeta[]> {
  if (fcIds.length === 0) return [];
  const endpoint = `${base.replace(/\/+$/, "")}/api/players/meta`;
  const url = `${endpoint}?fcIds=${fcIds.join(",")}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
  });
  // 报错里不带上整串 fcId（90 个 id 能把一行日志撑到几百字符），只给批大小
  if (!res.ok) {
    throw new Error(`GET ${endpoint}（${fcIds.length} 个 fcId）返回 ${res.status}`);
  }
  const body = (await res.json()) as { players?: unknown };
  if (!Array.isArray(body.players)) {
    throw new Error(`GET ${endpoint} 响应里没有 players 数组`);
  }

  const out: ClubPlayerMeta[] = [];
  for (const raw of body.players) {
    const p = raw as {
      fcId?: unknown;
      height?: unknown;
      attrs?: unknown;
      playstyles?: unknown;
    };
    if (typeof p.fcId !== "number" || !Number.isInteger(p.fcId) || p.fcId <= 0) {
      continue;
    }
    out.push({
      fcId: p.fcId,
      height:
        typeof p.height === "number" && Number.isFinite(p.height)
          ? Math.round(p.height)
          : null,
      attrs: cleanAttrs(p.attrs),
      playstyles: cleanPlaystyles(p.playstyles),
    });
  }
  return out;
}

/**
 * 整行覆盖写（本表没有别的写者，不存在两侧互相覆盖）：一人一行，
 * 三份数据（身高 / 属性 / 徽章）在 club 侧是同时刻的口径，必须一起更新，所以不拆成多语句。
 * 返回实际写入的行数。
 */
export async function upsertPlayerMeta(
  db: D1Database,
  rows: ClubPlayerMeta[],
  syncedAt: string
): Promise<number> {
  const stmts = rows.map((r) =>
    db
      .prepare(
        "INSERT INTO player_meta (fc_id, height, attrs, playstyles, synced_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(fc_id) DO UPDATE SET height = excluded.height, attrs = excluded.attrs, " +
          "playstyles = excluded.playstyles, synced_at = excluded.synced_at"
      )
      .bind(
        r.fcId,
        r.height,
        JSON.stringify(r.attrs),
        JSON.stringify(r.playstyles),
        syncedAt
      )
  );
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    await db.batch(stmts.slice(i, i + BATCH_CHUNK));
  }
  return stmts.length;
}

export interface MetaSyncSummary {
  /** 实际发出的批次数（不含被跳过的） */
  batches: number;
  /** 俱乐部平台返回、通过形状过滤的元数据条数 */
  fetched: number;
  /** 实际落库的行数（一条数据都没拿到的球员不写） */
  upserted: number;
  /** 拉取失败的批次数；> 0 表示部分球员这次没更新 */
  failedBatches: number;
  /** 整体跳过时的原因（此时各计数为 0） */
  skipped?: string;
}

/**
 * 同步入口：给一批 fcId，分批拉取并落库。**保证不抛**（调用点在名册同步里，失败绝不能中断它）。
 * 只拉本仓 player 表有的 fcId —— player 是俱乐部的镜像，快照里已经走了的人（或对账前压根没建过的队）
 * 拉回来也没人读，白占 D1 行数与请求配额。
 */
export async function syncPlayerMeta(
  env: Bindings,
  fcIds: number[]
): Promise<MetaSyncSummary> {
  const out: MetaSyncSummary = {
    batches: 0,
    fetched: 0,
    upserted: 0,
    failedBatches: 0,
  };
  try {
    const base = env.CLUB_API_BASE;
    if (!base) return { ...out, skipped: "未配置 CLUB_API_BASE" };

    const wanted = [...new Set(fcIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (wanted.length === 0) return { ...out, skipped: "没有可拉的球员" };

    const rows = await env.DB.prepare("SELECT id FROM player").all<{ id: number }>();
    const known = new Set(rows.results.map((r) => r.id));
    const ids = wanted.filter((id) => known.has(id));
    if (ids.length === 0) return { ...out, skipped: "这批 fcId 在本仓 player 表里都没有" };

    // 一次同步共用同一个时间戳：同轮落库的行在玩家眼里是「一次刷新」
    const syncedAt = new Date().toISOString();
    for (let i = 0; i < ids.length; i += META_BATCH) {
      const chunk = ids.slice(i, i + META_BATCH);
      try {
        const batch = await fetchPlayerMetaBatch(base, chunk);
        out.batches += 1;
        out.fetched += batch.length;
        if (batch.length > 0) out.upserted += await upsertPlayerMeta(env.DB, batch, syncedAt);
      } catch (e) {
        out.failedBatches += 1;
        console.error(
          `[sync-player-meta] 第 ${i / META_BATCH + 1} 批（${chunk.length} 人）失败：` +
            `${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return out;
  } catch (e) {
    // 兜底：读 player 表、写库这类「不该失败」的环节挂了也只是一条日志
    return {
      ...out,
      failedBatches: out.failedBatches + 1,
      skipped: `同步中断：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 一行日志文案：名册同步与 admin 路由共用，别在两处各写一遍格式 */
export function metaSyncLog(s: MetaSyncSummary): string {
  return (
    `[sync-player-meta] ${s.batches} 批 / 取回 ${s.fetched} 人 / 落库 ${s.upserted}` +
    (s.failedBatches > 0 ? ` / 失败 ${s.failedBatches} 批` : "") +
    (s.skipped ? `（跳过：${s.skipped}）` : "")
  );
}
