import type { RankZone, RankZoneSettings, RankZoneStyle } from "./types";

// 排名段标记（存 tournament.config_json.rankZones / rankZoneStyle）。
// 解析、校验、命中规则都放 shared，worker 与前端共用。

const MIN_RANK = 1;
const MAX_RANK = 99;
export const MAX_ZONES = 12;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const ZONE_PRESET_COLORS = [
  "#16a34a", // 绿
  "#dc2626", // 红
  "#2563eb", // 蓝
  "#d97706", // 金
  "#7c3aed", // 紫
  "#ea580c", // 橙
  "#0891b2", // 青
  "#6b7280", // 灰
] as const;

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_COLOR.test(v);
}

function isIntInRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

// 宽松解析：坏 JSON / 非法项静默丢弃（旧数据容错，渲染侧永不崩）。
// 一个 zone 都没有时返回 null（= 未配置）。
export function parseRankZoneSettings(
  configJson: string | null | undefined
): RankZoneSettings | null {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = (JSON.parse(configJson || "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = cfg.rankZones;
  // 两种形状都认：PATCH 落库存 rankZones 数组 + rankZoneStyle 字符串；
  // 对象形状 {style, zones} 作为兼容（直接写库的旧数据）。
  let styleRaw: unknown = "strip";
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) {
    styleRaw = cfg.rankZoneStyle;
    list = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const rz = raw as Record<string, unknown>;
    styleRaw = rz.style;
    if (Array.isArray(rz.zones)) list = rz.zones;
  }
  const style: RankZoneStyle = styleRaw === "divider" ? "divider" : "strip";
  if (!list) return null;
  const zones: RankZone[] = [];
  for (const item of list) {
    const z = coerceZone(item);
    if (z) zones.push(z);
    if (zones.length >= MAX_ZONES) break;
  }
  if (zones.length === 0) return null;
  return { style, zones };
}

function coerceZone(item: unknown): RankZone | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const color = isHexColor(r.color) ? r.color : null;
  if (!name || name.length > 24 || !color) return null;
  if (!isIntInRange(r.from, MIN_RANK, MAX_RANK)) return null;
  if (!isIntInRange(r.to, MIN_RANK, MAX_RANK)) return null;
  if (r.from > r.to) return null;
  const scope = coerceScope(r.scope);
  if (!scope) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : "",
    name,
    from: r.from,
    to: r.to,
    color,
    enabled: r.enabled !== false,
    scope,
  };
}

function coerceScope(v: unknown): RankZone["scope"] | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (s.kind === "all") return { kind: "all" };
  if (s.kind === "stage" && isIntInRange(s.stageId, 1, Number.MAX_SAFE_INTEGER))
    return { kind: "stage", stageId: s.stageId };
  if (s.kind === "group" && isIntInRange(s.groupId, 1, Number.MAX_SAFE_INTEGER))
    return { kind: "group", groupId: s.groupId };
  return null;
}

// 严格校验（管理端保存入口用）：返回 true 或中文错误信息。
// scope 引用是否真实存在由调用方（有 DB 的路由）补查。
export function validateRankZoneSettings(
  input: unknown
): { style: RankZoneStyle; zones: RankZone[] } | string {
  if (typeof input !== "object" || input === null) return "排名段标记配置无效";
  const r = input as Record<string, unknown>;
  if (r.style !== undefined && r.style !== "strip" && r.style !== "divider")
    return "展示样式无效";
  const style: RankZoneStyle = r.style === "divider" ? "divider" : "strip";
  if (!Array.isArray(r.zones)) return "排名段标记配置无效";
  if (r.zones.length > MAX_ZONES) return `排名段标记至多 ${MAX_ZONES} 条`;
  const zones: RankZone[] = [];
  for (const item of r.zones) {
    const z = coerceZone(item);
    if (!z) return "排名段标记存在无效条目（名称 1–24 字、颜色 #rrggbb、名次区间 1–99 且起点≤终点）";
    zones.push(z);
  }
  const ids = new Set(zones.map((z) => z.id));
  if (ids.size !== zones.length) return "排名段标记存在重复条目";
  return { style, zones };
}

// 命中：数组顺序即优先级，返回第一条命中的标记；未命中返回 null。
// stageId/groupId 为该行所属积分表（组表传组 id；无组循环表 groupId 传 null）。
export function matchRankZone(
  rank: number,
  zones: RankZone[],
  stageId: number,
  groupId: number | null
): RankZone | null {
  for (const z of zones) {
    if (!z.enabled) continue;
    if (
      (z.scope.kind === "all" ||
        (z.scope.kind === "stage" && z.scope.stageId === stageId) ||
        (z.scope.kind === "group" && groupId !== null && z.scope.groupId === groupId)) &&
      rank >= z.from &&
      rank <= z.to
    ) {
      return z;
    }
  }
  return null;
}

// 一张积分表适用的标记（图例用，按优先级序）：scope 命中该表即适用。
export function zonesForTable(
  zones: RankZone[],
  stageId: number,
  groupIds: number[]
): RankZone[] {
  return zones.filter(
    (z) =>
      z.enabled &&
      (z.scope.kind === "all" ||
        (z.scope.kind === "stage" && z.scope.stageId === stageId) ||
        (z.scope.kind === "group" && groupIds.includes(z.scope.groupId)))
  );
}
