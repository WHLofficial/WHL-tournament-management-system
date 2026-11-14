// 赛历导入与开球时刻回填的纯逻辑（开球时刻排期器 P3-A）。
//
// 这个文件不碰 D1：输入是 CSV 文本和「库里已有的场次行」，输出是结构化的窗口表、
// 时刻池和逐场 UPDATE 计划。落库由 scripts/import-calendar.ts 与
// scripts/backfill-kickoff.ts 生成 SQL 后交给 wrangler 执行 —— 这样映射规则可以在
// vitest 里逐条钉死，不必连库。
//
// 口径见 migrations/0031_schedule_calendar.sql 顶部三条：时刻是虚拟时刻、窗口主键带
// stream、leg 为 NULL 表示单回合。

export type Phase = "summer" | "autumn" | "winter" | "spring";
export type Competition = "top" | "sub" | "cup";
export type Stream = "league" | "playoff" | "group" | "elim";

/** 赛事键 → tournament.name 的中文部分（全名是 `${season} | ${部分}`） */
export const COMPETITION_LABEL: Record<Competition, string> = {
  top: "顶级联赛",
  sub: "次级联赛",
  cup: "冠军杯",
};

/** stream → 该赛事里对应的 stage.kind */
export const STAGE_KIND_BY_STREAM: Record<Stream, "round_robin" | "group" | "elim"> = {
  league: "round_robin",
  playoff: "round_robin",
  group: "group",
  elim: "elim",
};

// ---------- 季节 ----------

// 2026-11-04 用户定稿：夏 1–7、秋 8–12、冬 13–18、春 19–23、夏 24–31。
const PHASE_RANGES: Array<{ from: number; to: number; phase: Phase }> = [
  { from: 1, to: 7, phase: "summer" },
  { from: 8, to: 12, phase: "autumn" },
  { from: 13, to: 18, phase: "winter" },
  { from: 19, to: 23, phase: "spring" },
  { from: 24, to: 31, phase: "summer" },
];

export function phaseForWeek(week: number): Phase {
  const hit = PHASE_RANGES.find((r) => week >= r.from && week <= r.to);
  if (!hit) throw new Error(`周次 ${week} 超出赛季范围（1–31）`);
  return hit.phase;
}

// ---------- CSV ----------

/** 最小 CSV 解析：处理 BOM、引号包裹与 "" 转义，空行丢弃。 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function pickColumn(header: string[], names: string[], what: string): number {
  const idx = header.findIndex((h) => names.includes(h.trim()));
  if (idx < 0) throw new Error(`赛历缺少「${what}」列（表头：${header.join(",")}）`);
  return idx;
}

// ---------- 标签映射 ----------

export type LabelMapping =
  | { kind: "window"; competition: Competition; stream: Stream; round: number; leg: number | null }
  | { kind: "skip"; reason: string }
  | { kind: "error"; reason: string };

// 次级季后赛轮数：CSV 的 次级联赛15–20 = 冲刺组/挑战组组内双循环 6 轮。
const SUB_PLAYOFF_FROM = 15;
const SUB_PLAYOFF_ROUNDS = 6;

/** `calendar_s9.csv` 的 label → 窗口键。不认识的标签一律报错，不静默跳过。 */
export function mapLabel(label: string): LabelMapping {
  const name = label.trim();
  if (name === "") return { kind: "error", reason: "标签为空" };
  if (name === "超级杯") return { kind: "skip", reason: "tour 不建超级杯赛事（Q17）" };
  if (name.includes("转会窗")) return { kind: "skip", reason: "转会窗不是比赛窗口（Q2）" };

  const top = /^顶级联赛(\d+)$/.exec(name);
  if (top) {
    return { kind: "window", competition: "top", stream: "league", round: Number(top[1]), leg: null };
  }

  const sub = /^次级联赛(\d+)$/.exec(name);
  if (sub) {
    const n = Number(sub[1]);
    if (n < SUB_PLAYOFF_FROM) {
      return { kind: "window", competition: "sub", stream: "league", round: n, leg: null };
    }
    const round = n - SUB_PLAYOFF_FROM + 1;
    if (round > SUB_PLAYOFF_ROUNDS) {
      return { kind: "error", reason: `${name} 超出季后赛轮次（最多 ${SUB_PLAYOFF_FROM + SUB_PLAYOFF_ROUNDS - 1}）` };
    }
    return { kind: "window", competition: "sub", stream: "playoff", round, leg: null };
  }

  const playoff = /^次级附加赛(首|次)回合$/.exec(name);
  if (playoff) {
    // 附加赛在 stage 5 只有 round 1，用 round 0 占位区分常规季后赛轮（从 1 起）。
    return { kind: "window", competition: "sub", stream: "playoff", round: 0, leg: playoff[1] === "首" ? 1 : 2 };
  }

  const group = /^冠军杯小组赛(\d+)$/.exec(name);
  if (group) {
    return { kind: "window", competition: "cup", stream: "group", round: Number(group[1]), leg: null };
  }

  // 决赛单回合：场次行的 leg 与联赛一样是 NULL（见 manualBracket.slotRows），窗口也用 NULL 对齐
  const elim: Array<[RegExp, number, number | null]> = [
    [/^冠军杯1\/4赛首回合$/, 1, 1],
    [/^冠军杯1\/4赛次回合$/, 1, 2],
    [/^冠军杯半决赛首回合$/, 2, 1],
    [/^冠军杯半决赛次回合$/, 2, 2],
    [/^冠军杯决赛$/, 3, null],
  ];
  for (const [re, round, leg] of elim) {
    if (re.test(name)) return { kind: "window", competition: "cup", stream: "elim", round, leg };
  }

  return { kind: "error", reason: `无法识别的赛历标签「${name}」` };
}

// ---------- 赛历 → 窗口 ----------

export interface CalendarWindow {
  label: string;
  competition: Competition;
  stream: Stream;
  round: number;
  leg: number | null;
  week: number;
  dayStart: number;
  dayEnd: number;
}

export interface CalendarSkip {
  label: string;
  category: string;
  reason: string;
}

export interface CalendarMapping {
  season: string;
  weeks: number;
  windows: CalendarWindow[];
  skipped: CalendarSkip[];
  errors: string[];
}

export function mapCalendarCsv(text: string): CalendarMapping {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("赛历 CSV 是空的");
  const header = rows[0];
  const col = {
    season: pickColumn(header, ["season", "赛季"], "season"),
    week: pickColumn(header, ["week", "周"], "week"),
    dayStart: pickColumn(header, ["day_start", "起始天"], "day_start"),
    dayEnd: pickColumn(header, ["day_end", "结束天"], "day_end"),
    label: pickColumn(header, ["label", "标签"], "label"),
    category: pickColumn(header, ["category", "类别"], "category"),
  };

  const windows: CalendarWindow[] = [];
  const skipped: CalendarSkip[] = [];
  const errors: string[] = [];
  let season = "";
  let weeks = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const label = (r[col.label] ?? "").trim();
    const category = (r[col.category] ?? "").trim();
    const seasonCell = (r[col.season] ?? "").trim();
    if (seasonCell === "") {
      errors.push(`第 ${line} 行缺少 season`);
      continue;
    }
    if (season === "") season = seasonCell;
    else if (season !== seasonCell) {
      errors.push(`第 ${line} 行的赛季「${seasonCell}」与文件首行「${season}」不一致`);
      continue;
    }
    const week = Number(r[col.week]);
    const dayStart = Number(r[col.dayStart]);
    const dayEnd = Number(r[col.dayEnd]);
    if (!Number.isInteger(week) || week < 1) {
      errors.push(`第 ${line} 行 week 非法：${r[col.week]}`);
      continue;
    }
    if (!Number.isInteger(dayStart) || !Number.isInteger(dayEnd) || dayStart < 1 || dayEnd > 7 || dayStart > dayEnd) {
      errors.push(`第 ${line} 行 day_start/day_end 非法：${r[col.dayStart]}/${r[col.dayEnd]}`);
      continue;
    }
    weeks = Math.max(weeks, week);

    const mapped = mapLabel(label);
    if (mapped.kind === "skip") {
      skipped.push({ label, category, reason: mapped.reason });
      continue;
    }
    if (mapped.kind === "error") {
      errors.push(`第 ${line} 行：${mapped.reason}`);
      continue;
    }
    windows.push({
      label,
      competition: mapped.competition,
      stream: mapped.stream,
      round: mapped.round,
      leg: mapped.leg,
      week,
      dayStart,
      dayEnd,
    });
  }

  // 同一赛事同一轮只允许一个窗口：重复会让排期器不知道用哪一周。
  const seen = new Map<string, string>();
  for (const w of windows) {
    const key = `${w.competition}|${w.stream}|${w.round}|${w.leg ?? 0}`;
    const prev = seen.get(key);
    if (prev) errors.push(`窗口重复：${prev} 与「${w.label}」都映射到 ${key}`);
    else seen.set(key, w.label);
  }

  if (weeks === 0) errors.push("赛历里没有任何 week");

  return { season, weeks, windows, skipped, errors };
}

// ---------- 时刻池 ----------

export interface TimeSlot {
  time: string;
  cap: number;
}

const eachSlot = (...times: string[]): TimeSlot[] => times.map((time) => ({ time, cap: 1 }));
/** 一格容两场：同一时刻允许两场同时开球（8/23 那次排期就有同刻开球）。 */
const doubleSlot = (...times: string[]): TimeSlot[] => times.map((time) => ({ time, cap: 2 }));
const cupDay = (): TimeSlot[] => [
  { time: "18:30", cap: 3 },
  { time: "21:00", cap: 2 },
];

// 从 2026-08-23 那次排期的产物反推（见 docs/design-kickoff-scheduler.md §3.4）。
// 冬春沿用秋季池，例外：冬季周末只排下午场（天冷、天黑早），三档各容两场（允许同刻开球）。
// 杯赛只有 day 2/3（小组赛、淘汰赛前两轮）与 day 6（决赛）。
const POOLS: Record<Competition, Partial<Record<Phase, Record<number, TimeSlot[]>>>> = {
  top: {
    summer: { 5: eachSlot("20:00", "20:30"), 6: eachSlot("17:30", "19:30", "20:30"), 7: doubleSlot("18:00", "20:00") },
    autumn: {
      5: eachSlot("19:30", "20:30"),
      6: eachSlot("12:30", "15:00", "17:30", "20:00"),
      7: eachSlot("14:00", "16:30", "20:00"),
    },
    // 冬季：周末改下午场（天冷、天黑早），工作日仍晚间；一轮 6 场，三档 × cap2 够放且有同刻开球余量
    winter: { 5: eachSlot("19:30", "20:30"), 6: doubleSlot("12:30", "14:30", "16:30"), 7: doubleSlot("12:30", "14:30", "16:30") },
  },
  sub: {
    summer: { 5: eachSlot("19:30", "20:00"), 6: eachSlot("17:30", "19:00"), 7: eachSlot("18:00", "19:30") },
    autumn: { 5: eachSlot("19:30", "20:30"), 6: eachSlot("13:30", "15:30", "17:00"), 7: eachSlot("14:00", "16:30") },
    winter: { 5: eachSlot("19:30", "20:30"), 6: eachSlot("13:30", "15:30"), 7: eachSlot("14:00", "16:00") },
  },
  cup: {
    summer: { 2: cupDay(), 3: cupDay(), 6: eachSlot("21:00") },
    autumn: { 2: cupDay(), 3: cupDay(), 6: eachSlot("21:00") },
    winter: { 2: cupDay(), 3: cupDay(), 6: eachSlot("21:00") },
    spring: { 2: cupDay(), 3: cupDay(), 6: eachSlot("21:00") },
  },
};

/** 取某季某赛事的整张池子；冬季有独立池，春季回落到秋季。 */
export function timePool(phase: Phase, competition: Competition): Record<number, TimeSlot[]> {
  const key: Phase = phase === "spring" ? "autumn" : phase;
  return POOLS[competition][key] ?? {};
}

export interface PoolRow {
  phase: Phase;
  competition: Competition;
  day: number;
  slots: TimeSlot[];
}

/** 迁移后要写进 time_pool 的全部行（每个 phase × competition × day 一条）。 */
export function poolRows(): PoolRow[] {
  const out: PoolRow[] = [];
  const phases: Phase[] = ["summer", "autumn", "winter", "spring"];
  for (const phase of phases) {
    for (const competition of ["top", "sub", "cup"] as const) {
      const pool = timePool(phase, competition);
      for (const day of Object.keys(pool).map(Number).sort((a, b) => a - b)) {
        out.push({ phase, competition, day, slots: pool[day] });
      }
    }
  }
  return out;
}

// 杯赛小组第 3 轮：窗口是两天，但历史全部 10 场都在第二天 21:00 开球。
// 用 round_window.slot_override 记下这个例外，别把它塞进通用池子。
// 带上 day：小组赛第 3 轮的窗口虽然给了两天，10 场全压在第二天 21:00。
export interface SlotOverride {
  day: number;
  slots: TimeSlot[];
}

const CUP_ROUND3_OVERRIDE: SlotOverride = { day: 3, slots: [{ time: "21:00", cap: 10 }] };

export function slotOverride(w: CalendarWindow): SlotOverride | null {
  if (w.competition === "cup" && w.stream === "group" && w.round === 3) return CUP_ROUND3_OVERRIDE;
  return null;
}

// ---------- SQL ----------

const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** 赛事全名（`S9 | 顶级联赛`），与线上命名一致。 */
export function tournamentName(season: string, competition: Competition): string {
  return `${season} | ${COMPETITION_LABEL[competition]}`;
}

/**
 * 生成赛历落库 SQL：season / season_week / time_pool / round_window。
 * 全部按唯一键 upsert，重复执行不会插重。
 *
 * 注意 INSERT ... SELECT 后面必须带 WHERE 再写 ON CONFLICT：SQLite 会把紧跟在 FROM
 * 子句后的 ON 当成 join 约束解析（仓库里踩过）。
 */
export function buildCalendarSql(mapping: CalendarMapping): string {
  if (mapping.errors.length > 0) throw new Error(`赛历有 ${mapping.errors.length} 处错误，先修再导`);
  const s = q(mapping.season);
  const out: string[] = [];

  out.push(
    `INSERT INTO season (name, weeks) VALUES (${s}, ${mapping.weeks})
ON CONFLICT(name) DO UPDATE SET weeks = excluded.weeks`,
  );

  for (let week = 1; week <= mapping.weeks; week++) {
    out.push(
      `INSERT INTO season_week (season_id, week, phase)
SELECT id, ${week}, ${q(phaseForWeek(week))} FROM season WHERE name = ${s}
ON CONFLICT(season_id, week) DO UPDATE SET phase = excluded.phase`,
    );
  }

  for (const p of poolRows()) {
    out.push(
      `INSERT INTO time_pool (season_id, phase, competition, day, slots)
SELECT id, ${q(p.phase)}, ${q(p.competition)}, ${p.day}, ${q(JSON.stringify(p.slots))} FROM season WHERE name = ${s}
ON CONFLICT(season_id, phase, competition, day) DO UPDATE SET slots = excluded.slots`,
    );
  }

  for (const w of mapping.windows) {
    const leg = w.leg === null ? "NULL" : String(w.leg);
    const override = slotOverride(w);
    const overrideSql = override ? q(JSON.stringify(override)) : "NULL";
    out.push(
      `INSERT INTO round_window (season_id, tournament_id, stream, round, leg, week, day_start, day_end, slot_override)
SELECT s.id, t.id, ${q(w.stream)}, ${w.round}, ${leg}, ${w.week}, ${w.dayStart}, ${w.dayEnd}, ${overrideSql}
  FROM season s JOIN tournament t ON t.name = ${q(tournamentName(mapping.season, w.competition))}
 WHERE s.name = ${s}
ON CONFLICT DO UPDATE SET week = excluded.week, day_start = excluded.day_start,
  day_end = excluded.day_end, slot_override = excluded.slot_override`,
    );
  }

  return out.map((sql) => `${sql};`).join("\n\n");
}

// ---------- 插件赛程 → tour 场次 ----------

export interface FixtureRow {
  label: string;
  home: string;
  away: string;
  week: number;
  day: number;
  time: string;
}

export function parseFixtureCsv(text: string): { rows: FixtureRow[]; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (table.length === 0) return { rows: [], errors: ["赛程 CSV 是空的"] };
  const header = table[0];
  const col = {
    label: pickColumn(header, ["轮次"], "轮次"),
    home: pickColumn(header, ["主队"], "主队"),
    away: pickColumn(header, ["客队"], "客队"),
    week: pickColumn(header, ["周"], "周"),
    day: pickColumn(header, ["天"], "天"),
    time: pickColumn(header, ["时间"], "时间"),
  };
  const rows: FixtureRow[] = [];
  const keys = new Set<string>();
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    const label = (r[col.label] ?? "").trim();
    const home = (r[col.home] ?? "").trim();
    const away = (r[col.away] ?? "").trim();
    const week = Number(r[col.week]);
    const day = Number(r[col.day]);
    const time = (r[col.time] ?? "").trim();
    if (!label || !home || !away) {
      errors.push(`第 ${line} 行轮次/主客队有空值`);
      continue;
    }
    if (!Number.isInteger(week) || week < 1 || !Number.isInteger(day) || day < 1 || day > 7) {
      errors.push(`第 ${line} 行周/天非法：${r[col.week]}/${r[col.day]}`);
      continue;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      errors.push(`第 ${line} 行时间非法：${time}`);
      continue;
    }
    const key = `${label}|${home}|${away}`;
    if (keys.has(key)) {
      errors.push(`第 ${line} 行重复：${key}`);
      continue;
    }
    keys.add(key);
    rows.push({ label, home, away, week, day, time });
  }
  return { rows, errors };
}

/** 队名归一：去掉 (CPU) / （CPU） 后缀与首尾空白 —— tour 里 AI 队带后缀，插件导入时已去掉。 */
export function normTeam(name: string): string {
  return name
    .replace(/[（(]\s*CPU\s*[)）]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DbMatchRow {
  id: number;
  tournament_name: string;
  stage_id: number;
  stage_sort: number;
  stage_kind: string;
  round: number;
  leg: number | null;
  home_name: string | null;
  away_name: string | null;
}

export interface BackfillUpdate {
  matchId: number;
  label: string;
  week: number;
  day: number;
  time: string;
  home: string;
  away: string;
}

export interface BackfillPlan {
  updates: BackfillUpdate[];
  /** 匹配不上的行：reason 说明是「库里的对手/轮次对不上」还是「标签不支持」 */
  unmatched: Array<{ fixture: FixtureRow; reason: string }>;
}

/**
 * 把插件 CSV 的每一行对到 tour 的 match.id。
 *
 * 认场规则：赛事（按 tournament.name 全名）→ 该赛事下 kind 匹配且 sort_order 最小的阶段
 * （次级还有冲刺组/挑战组两个 round_robin，不能让 1–14 轮撞进去）→ 轮次 → 归一后的主客队名。
 * 主客反了不算命中，单独报出来 —— 那说明两边数据真的有分歧。
 */
export function planBackfill(fixtures: FixtureRow[], dbRows: DbMatchRow[]): BackfillPlan {
  const byTournament = new Map<string, DbMatchRow[]>();
  for (const r of dbRows) {
    const list = byTournament.get(r.tournament_name) ?? [];
    list.push(r);
    byTournament.set(r.tournament_name, list);
  }

  // (tournament, stageKind) → 主阶段 id（sort_order 最小）
  const primaryStage = new Map<string, number>();
  for (const [name, rows] of byTournament) {
    for (const r of rows) {
      const key = `${name}|${r.stage_kind}`;
      const prev = primaryStage.get(key);
      if (prev === undefined) {
        primaryStage.set(key, r.stage_id);
        continue;
      }
      const prevSort = rows.find((x) => x.stage_id === prev)?.stage_sort ?? Number.MAX_SAFE_INTEGER;
      if (r.stage_sort < prevSort) primaryStage.set(key, r.stage_id);
    }
  }

  const index = new Map<string, DbMatchRow[]>();
  for (const r of dbRows) {
    if (r.home_name === null || r.away_name === null) continue;
    const key = `${r.stage_id}|${r.round}|${normTeam(r.home_name)}|${normTeam(r.away_name)}`;
    const list = index.get(key) ?? [];
    list.push(r);
    index.set(key, list);
  }

  const updates: BackfillUpdate[] = [];
  const unmatched: BackfillPlan["unmatched"] = [];

  for (const f of fixtures) {
    const mapped = mapLabel(f.label);
    if (mapped.kind !== "window") {
      unmatched.push({ fixture: f, reason: mapped.reason });
      continue;
    }
    if (mapped.stream === "playoff") {
      unmatched.push({ fixture: f, reason: "附加赛/季后赛不参与本次回填" });
      continue;
    }
    const stageKind = STAGE_KIND_BY_STREAM[mapped.stream];
    const names = [...byTournament.keys()].filter((n) => n.endsWith(` | ${COMPETITION_LABEL[mapped.competition]}`));
    if (names.length !== 1) {
      unmatched.push({ fixture: f, reason: `库里有 ${names.length} 个「${COMPETITION_LABEL[mapped.competition]}」赛事，无法唯一确定` });
      continue;
    }
    const tournament = names[0];
    const stageId = primaryStage.get(`${tournament}|${stageKind}`);
    if (stageId === undefined) {
      unmatched.push({ fixture: f, reason: `「${tournament}」没有 ${stageKind} 阶段` });
      continue;
    }
    const key = `${stageId}|${mapped.round}|${normTeam(f.home)}|${normTeam(f.away)}`;
    const hit = index.get(key) ?? [];
    if (hit.length === 1) {
      updates.push({
        matchId: hit[0].id,
        label: f.label,
        week: f.week,
        day: f.day,
        time: f.time,
        home: f.home,
        away: f.away,
      });
      continue;
    }
    if (hit.length > 1) {
      unmatched.push({ fixture: f, reason: `命中 ${hit.length} 场（match id ${hit.map((h) => h.id).join("/")}）` });
      continue;
    }
    const reverse = index.get(`${stageId}|${mapped.round}|${normTeam(f.away)}|${normTeam(f.home)}`) ?? [];
    unmatched.push({
      fixture: f,
      reason: reverse.length > 0 ? `主客反了（match id ${reverse.map((h) => h.id).join("/")}）` : "没有对得上的场次",
    });
  }

  const dup = new Set<number>();
  for (const u of updates) {
    if (dup.has(u.matchId)) throw new Error(`同一场被匹配两次：match ${u.matchId}`);
    dup.add(u.matchId);
  }
  return { updates, unmatched };
}

// ---------- 约束回放 ----------

export interface KickoffPoint {
  matchId: number;
  home: string;
  away: string;
  week: number;
  day: number;
  time: string;
}

export interface ConstraintPair {
  team: string;
  firstMatchId: number;
  secondMatchId: number;
  gapHours: number;
}

export interface ConstraintReplay {
  matches: number;
  teams: number;
  /** 同一队相邻两场的间隔（开球到开球，虚拟轴） */
  pairs: number;
  minGapHours: number;
  under48: ConstraintPair[];
  under64: number;
  under72: number;
}

/** 虚拟轴上的绝对小时：day 1 = 周一，不涉及真实日期与时区。 */
export function kickoffHours(week: number, day: number, time: string): number {
  const [h, m] = time.split(":").map(Number);
  return ((week - 1) * 7 + (day - 1)) * 24 + h + m / 60;
}

/**
 * 复算「同队两场间隔」：这是排期器最硬的一条约束，也是回填唯一能被机器验证的部分
 * （历史 136 场全在已完赛轮次，没有前瞻样本可对齐）。
 */
export function replayConstraints(rows: KickoffPoint[]): ConstraintReplay {
  const byTeam = new Map<string, Array<{ id: number; hours: number }>>();
  for (const r of rows) {
    const hours = kickoffHours(r.week, r.day, r.time);
    for (const team of [normTeam(r.home), normTeam(r.away)]) {
      const list = byTeam.get(team) ?? [];
      list.push({ id: r.matchId, hours });
      byTeam.set(team, list);
    }
  }

  const under48: ConstraintPair[] = [];
  let pairs = 0;
  let minGap = Number.POSITIVE_INFINITY;
  let under64 = 0;
  let under72 = 0;

  for (const [team, list] of byTeam) {
    list.sort((a, b) => a.hours - b.hours);
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].hours - list[i - 1].hours;
      pairs++;
      minGap = Math.min(minGap, gap);
      if (gap < 48) {
        under48.push({ team, firstMatchId: list[i - 1].id, secondMatchId: list[i].id, gapHours: gap });
      }
      if (gap < 64) under64++;
      if (gap < 72) under72++;
    }
  }

  return {
    matches: rows.length,
    teams: byTeam.size,
    pairs,
    minGapHours: pairs === 0 ? 0 : minGap,
    under48,
    under64,
    under72,
  };
}

/** 回填 SQL：逐场 UPDATE，按 id 定点写，重复执行结果不变。 */
export function buildBackfillSql(plan: BackfillPlan): string {
  return plan.updates
    .map(
      (u) =>
        `UPDATE match SET kickoff_week = ${u.week}, kickoff_day = ${u.day}, kickoff_time = ${q(u.time)} WHERE id = ${u.matchId};`,
    )
    .join("\n");
}
