// 球员附加信息（FC26 属性 / 徽章 / 身高）的只读拉取：查 player_meta 表（见 migrations/0026）。
// player 表只有 id/name/number，这几个字段是随名册同步从俱乐部平台镜像下来的
// （写侧在 worker/lib/clubMeta.ts），这里只负责按 id 查出来给战术页用。
// 查不到就整条不进 Map —— DTO 里 meta 字段缺省，UI 按「有 meta 才渲染」降级。
import type { PlayerMeta } from "../../shared/types";
import { ATTR_KEYS } from "../../shared/tactics";
import { FIT_ATTR_KEYS } from "../../shared/roleFit";

// 单条 IN 查询的 id 上限。一次战术板点到的人远少于此，分批只为防 SQLite 的变量数上限。
const ID_CHUNK = 50;

/** attrs 列：坏 JSON / 非对象降级成空表，只留有限数值 */
function parseAttrs(raw: string | null): Record<string, number> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw ?? "");
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** playstyles 列：坏 JSON / 非数组降级成空表，只留正整数并去重排序（顺序稳定便于测试与 diff） */
function parsePlaystyles(raw: string | null): number[] {
  let obj: unknown;
  try {
    obj = JSON.parse(raw ?? "");
  } catch {
    return [];
  }
  if (!Array.isArray(obj)) return [];
  const seen = new Set<number>();
  for (const v of obj) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * 按球员 id 批量取附加信息；没数据的球员不会出现在 Map 里（调用方按可选字段处理）。
 * 读失败不当异常往上抛：meta 是附加展示信息，不该让阵容读出 500（表没迁移、字段脏都在此兜住）。
 */
export async function loadPlayerMeta(
  db: D1Database,
  playerIds: number[],
): Promise<Map<number, PlayerMeta>> {
  const out = new Map<number, PlayerMeta>();
  const ids = [
    ...new Set(playerIds.filter((id) => Number.isInteger(id) && id > 0)),
  ];
  if (ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    let rows: {
      fc_id: number;
      height: number | null;
      attrs: string | null;
      playstyles: string | null;
    }[];
    try {
      const res = await db
        .prepare(
          `SELECT fc_id, height, attrs, playstyles FROM player_meta WHERE fc_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{
          fc_id: number;
          height: number | null;
          attrs: string | null;
          playstyles: string | null;
        }>();
      rows = res.results ?? [];
    } catch (e) {
      console.error("[player-meta] 读取失败，本次附加信息整体降级：", e);
      return out;
    }

    for (const row of rows) {
      const attrs = parseAttrs(row.attrs);
      const playstyles = parsePlaystyles(row.playstyles);
      const height =
        typeof row.height === "number" && Number.isFinite(row.height)
          ? row.height
          : null;
      const meta: PlayerMeta = {};
      if (Object.keys(attrs).length > 0) meta.attrs = attrs;
      if (playstyles.length > 0) meta.playstyles = playstyles;
      if (height !== null) meta.height = height;
      // 全都空说明这行是脏数据，整条不进 Map（维持「没数据就没有 meta」的旧语义）
      if (meta.attrs || meta.playstyles || meta.height !== undefined) {
        out.set(row.fc_id, meta);
      }
    }
  }
  return out;
}

// 名册级下发的 attrs 白名单（trimPlayerMetaForPool 用，模块级算一次）：
// ① ATTR_KEYS（shared/tactics.ts，11 键）——定位球指派的相关性表继续用；
// ② FIT_ATTR_KEYS（shared/roleFit.ts）——FIT 权重表的键并集，从 ROLE_FIT 派生、与权重表
//    永不漂移（tests/roleFit.test.ts 钉住），fitScore 引擎算 base 的输入；
// ③ RoleID1-5 / PosID1-4 —— FC26 熟悉度与位置 id，fitScore 加分项（+3/+5 与 +2）的输入；
// ④ CA/PA —— 仅展示参考（候选行 CA 列、明细 CA/PA 标注），随 trim 下发但引擎不读、
//    不进 FIT_ATTR_KEYS、不参与任何计算与排序（用户 2026-10-25 修订，原「不下发」作废）。
// 刻意不带：PSID1-15（徽章统一走 playstyles，clubMeta 侧已从 PSID 补齐）、TeamID 等其余元数据。
const POOL_ATTR_KEYS: readonly string[] = [
  ...new Set<string>([
    ...Object.values(ATTR_KEYS),
    ...FIT_ATTR_KEYS,
    ...[1, 2, 3, 4, 5].map((i) => `RoleID${i}`),
    ...[1, 2, 3, 4].map((i) => `PosID${i}`),
    "CA",
    "PA",
  ]),
];

/**
 * 名册级下发（/me/team 与 /bootstrap 的 team.players、代打板的 players）用的裁剪版 meta：
 * 一队几十个人头一次带走，attrs 里 club 下发的是 71 键，而战术页只消费上面 POOL_ATTR_KEYS
 * 那一份白名单（指派相关性 11 键 + FIT 引擎的权重键与 RoleID/PosID）——其余键前端永远
 * 碰不到，留着只是白占首屏体积与 KV 缓存。
 * 全空返回 undefined：调用方据此不加空壳字段，维持「没 meta 就按无数据渲染」的口径。
 * 徽章只认 playstyles 里的金/银 id，条数本来就少，原样带走。
 */
export function trimPlayerMetaForPool(m: PlayerMeta): PlayerMeta | undefined {
  const out: PlayerMeta = {};
  if (typeof m.height === "number" && Number.isFinite(m.height)) out.height = m.height;
  const attrs: Record<string, number> = {};
  if (m.attrs) {
    for (const k of POOL_ATTR_KEYS) {
      const v = m.attrs[k];
      if (typeof v === "number" && Number.isFinite(v)) attrs[k] = v;
    }
  }
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  if (m.playstyles && m.playstyles.length > 0) out.playstyles = [...m.playstyles];
  if (out.height === undefined && !out.attrs && !out.playstyles) return undefined;
  return out;
}
