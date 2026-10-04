// 淘汰赛「出线队」解析 + 首轮空席位候选占位文案。
// 纯函数：不碰数据库、不发 IO；来源阶段名次行（含 groupName）由调用方备好。
// 所有脏数据（非法 token / 越界名次 / 配置缺失 / cross 非数组）只降级为空或跳过，永不抛异常。
//
// cross 模板语义与生成端一致（worker/routes/admin/schedule.ts buildCrossStagePlan、
// worker/lib/seeding.ts buildCrossPlan）：元素形如 "A1-B2"，token = 组字母 + 组内名次；
// 第 s 场（slot 1 起）用展平后第 2s-2、2s-1 个 token，前者主队、后者客队。
// range 区间语义与 takeRangePool 一致：from 缺省 1，to 缺省 take ?? from，按名次 from..to（含端点）。

export interface QualifierRow {
  entryId: number;
  teamName: string;
  /** 名次（1 起）。cross 用组内名次定位；range 按此过滤——组来源跨组取人时由调用方按取人排序重编。 */
  rank: number;
  /** 所属组名（"A" / "A组" / "a" 均可；非分组阶段为 null/缺省）。cross token 按它定位。 */
  groupName?: string | null;
}

export interface FirstRoundSeatInput {
  /** 淘汰阶段配置（读 config.source）；也容忍直接传 source 对象 */
  config?: unknown;
  /** 来源阶段显示名（range >2 支概括文案用；缺失时概括回退 null） */
  sourceStageName?: string | null;
  /** 来源阶段 kind；"elim" 无名次可取，直接算不出 */
  sourceStageKind?: string | null;
  /** 来源阶段名次行（缺省/空 = 名次未定） */
  sourceRows?: readonly QualifierRow[] | null;
  /** 首轮场次序号（1 起） */
  slot: number;
}

export interface SeatLabels {
  home: string | null;
  away: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 取 stage config 的 source：允许直接传 source 对象（无 source 字段时回退自身）
function extractSource(config: unknown): Record<string, unknown> | null {
  if (!isRecord(config)) return null;
  const inner = config.source;
  if (isRecord(inner)) return inner;
  if (
    inner == null &&
    ("cross" in config || "from" in config || "to" in config || "take" in config)
  ) {
    return config;
  }
  return null;
}

interface SeatToken {
  group: string; // A-P 大写
  pos: number; // 1-9
}

// 与生成端同一口径：组字母 A-P + 单位名次
const SEAT_RE = /^([A-Pa-p])([1-9])$/;

function parseSeatToken(raw: unknown): SeatToken | null {
  if (typeof raw !== "string") return null;
  const m = SEAT_RE.exec(raw.trim());
  if (!m) return null;
  return { group: m[1].toUpperCase(), pos: Number(m[2]) };
}

// cross 配置 → 展平的两两 token 序列（按席位顺序，主/客交替）。
// 返回 null = 未配置/空（可回退 range）；元素为 null = 该席位非法（保留位置，配对位次不掉队）。
function flattenCross(cross: unknown): Array<SeatToken | null> | null {
  let entries: unknown[];
  if (Array.isArray(cross)) {
    entries = cross.filter((e) => typeof e !== "string" || e.trim() !== "");
  } else if (typeof cross === "string") {
    // 兼容逗号分隔字符串（与生成端兼容分支同一口径）
    entries = cross
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return null;
  }
  if (entries.length === 0) return null;
  const flat: Array<SeatToken | null> = [];
  for (const entry of entries) {
    const halves = typeof entry === "string" ? entry.split("-") : [];
    flat.push(parseSeatToken(halves[0]), parseSeatToken(halves[1]));
  }
  return flat;
}

// 组名归一：去空白、去尾部「组」、大写（"A" / "A组" / "a" → "A"）
function normalizeGroupName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s*组$/, "").trim().toUpperCase();
  return s || null;
}

// 只校验「组 + 组内名次」是否命中，不按来源阶段的 qualify_per_group 限制名次上限：
// 这份模板只用于出线标记与空席位占位（展示用途），写错 token 的代价是标错一队，
// 不值得为此拒绝整份配置（赛程生成路径已废弃，不再校验）
function matchCrossRow(
  rows: readonly QualifierRow[],
  tok: SeatToken
): QualifierRow | undefined {
  return rows.find(
    (r) =>
      Number.isInteger(r.rank) &&
      r.rank === tok.pos &&
      normalizeGroupName(r.groupName) === tok.group
  );
}

interface RangeSpec {
  from: number;
  to: number;
}

function asPosInt(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function rangeSpec(source: Record<string, unknown>): RangeSpec | null {
  if (source.from == null && source.to == null && source.take == null) return null;
  const from = source.from == null ? 1 : asPosInt(source.from);
  const to =
    source.to == null
      ? source.take == null
        ? from
        : asPosInt(source.take)
      : asPosInt(source.to);
  if (from == null || to == null || to < from) return null;
  return { from, to };
}

// ---------- 出线队解析（best-effort，解不出返回空） ----------

export function resolveQualifiers(
  config: unknown,
  rows: readonly QualifierRow[]
): number[] {
  const source = extractSource(config);
  if (!source) return [];
  const list = Array.isArray(rows) ? rows : [];

  const cross = flattenCross(source.cross);
  if (cross) {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const tok of cross) {
      if (!tok) continue;
      const hit = matchCrossRow(list, tok);
      if (!hit || seen.has(hit.entryId)) continue;
      seen.add(hit.entryId);
      out.push(hit.entryId);
    }
    return out;
  }

  const range = rangeSpec(source);
  if (range) {
    const picked = list
      .filter(
        (r) => Number.isInteger(r.rank) && r.rank >= range.from && r.rank <= range.to
      )
      .sort((a, b) => a.rank - b.rank);
    const out: number[] = [];
    const seen = new Set<number>();
    for (const r of picked) {
      if (seen.has(r.entryId)) continue;
      seen.add(r.entryId);
      out.push(r.entryId);
    }
    return out;
  }

  return [];
}

// ---------- 首轮空席位候选占位文案 ----------

const formatRange = (r: RangeSpec): string =>
  r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;

// 名次已定（行里有队名）→ 队名；名次未定 → token 摘要「A 组第 1」；席位非法 → null
function crossSeatLabel(
  tok: SeatToken | null | undefined,
  rows: readonly QualifierRow[]
): string | null {
  if (!tok) return null;
  const hit = matchCrossRow(rows, tok);
  const name = typeof hit?.teamName === "string" ? hit.teamName.trim() : "";
  if (name) return name;
  return `${tok.group} 组第 ${tok.pos}`;
}

function rangeSeatLabel(
  range: RangeSpec,
  rows: readonly QualifierRow[],
  stageName: unknown
): string | null {
  const picked = rows
    .filter(
      (r) => Number.isInteger(r.rank) && r.rank >= range.from && r.rank <= range.to
    )
    .sort((a, b) => a.rank - b.rank);
  if (picked.length === 0) return null;
  // >2 支只给概括，避免逐席位铺队名炸屏；来源阶段名缺失则算不出（调用方回退「待定」）
  if (picked.length > 2) {
    const name = typeof stageName === "string" ? stageName.trim() : "";
    if (!name) return null;
    return `${name} 第 ${formatRange(range)} 名`;
  }
  const names = picked
    .map((r) => (typeof r.teamName === "string" ? r.teamName.trim() : ""))
    .filter(Boolean);
  return names.length > 0 ? names.join("/") : null;
}

export function firstRoundSeatLabels(input: FirstRoundSeatInput): SeatLabels {
  const empty: SeatLabels = { home: null, away: null };
  if (!input || input.sourceStageKind === "elim") return empty;
  if (!Number.isInteger(input.slot) || input.slot < 1) return empty;
  const source = extractSource(input.config);
  if (!source) return empty;
  const rows = Array.isArray(input.sourceRows) ? input.sourceRows : [];

  const cross = flattenCross(source.cross);
  if (cross) {
    return {
      home: crossSeatLabel(cross[2 * input.slot - 2], rows),
      away: crossSeatLabel(cross[2 * input.slot - 1], rows),
    };
  }

  const range = rangeSpec(source);
  if (range) {
    const label = rangeSeatLabel(range, rows, input.sourceStageName);
    return { home: label, away: label };
  }

  return empty;
}
