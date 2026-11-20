// 开球时刻排期器：纯计算，不碰 D1。
//
// 口径（见 docs/design-kickoff-scheduler.md）：
// - 时刻是**虚拟时刻**：`HH:MM` 只是标签，永不换算真实日期/时区。
//   时间轴 = ((周-1)*7 + (天-1)) 天，day 1 = 周一；间隔一律按「开球到开球」算。
// - 排期单位是 round_window（tournament + stream + round + leg），一个窗口 1–N 场。
// - 拆天：按 slot 排序后前一半放 day_start、后一半放 day_end（联赛 3+3、杯赛 2+2）。
// - 定序：越疲劳（距上一场越近）越先拿，先拿的人拿最晚的档。
// - 约束：同队两场 ≥48h（硬）；非「两连主」≥64h（软，放宽后记 warning）；<72h 只报告。

export interface Slot {
  time: string;
  cap: number;
}

export interface SchedMatch {
  id: number;
  slot: number;
  homeTeamId: number | null;
  awayTeamId: number | null;
}

export interface TeamHistory {
  /** 上一场开球的绝对小时（虚拟轴） */
  lastStartHours: number;
  /** 上一场是不是主场（两连主可只用 48h） */
  lastWasHome: boolean;
}

export type History = Map<number, TeamHistory>;

export interface ScheduleInput {
  week: number;
  dayStart: number;
  dayEnd: number;
  /** 每天可用的档位：day → slots（D6/D7 的池子通常不同） */
  pool: Record<number, Slot[]>;
  matches: SchedMatch[];
  history: History;
}

export interface Assignment {
  matchId: number;
  week: number;
  day: number;
  time: string;
}

export interface Conflict {
  matchId: number;
  level: "hard" | "soft";
  reason: string;
}

export interface ScheduleResult {
  assignments: Assignment[];
  conflicts: Conflict[];
}

export const MIN_GAP_HOURS = 48;
export const SOFT_GAP_HOURS = 64;
export const REPORT_GAP_HOURS = 72;

export function parseTime(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`时刻格式不对：${time}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`时刻越界：${time}`);
  return h * 60 + min;
}

/** 虚拟轴上的绝对小时：第 1 周周一 00:00 = 0 */
export function absHours(week: number, day: number, time: string): number {
  return ((week - 1) * 7 + (day - 1)) * 24 + parseTime(time) / 60;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 确定性伪随机（mulberry32）：赛季排期的段内局部搜索用。
 * 固定 seed → 固定随机序列，同一份库态重复求解结果一致（可复现验收靠它）。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 拆天：前半放 day_start，后半放 day_end；窗口只有一天就全放 day_start */
export function splitByDay<T extends { slot: number }>(
  matches: T[],
  dayStart: number,
  dayEnd: number
): Array<{ day: number; matches: T[] }> {
  const sorted = [...matches].sort((a, b) => a.slot - b.slot);
  if (dayEnd <= dayStart) return [{ day: dayStart, matches: sorted }];
  const first = Math.ceil(sorted.length / 2);
  const head = sorted.slice(0, first);
  const tail = sorted.slice(first);
  return tail.length === 0
    ? [{ day: dayStart, matches: head }]
    : [
        { day: dayStart, matches: head },
        { day: dayEnd, matches: tail },
      ];
}

/** 该场双方里最疲劳的一方距窗口起点多少小时（都没有历史 = 无穷大） */
function fatigueOf(m: SchedMatch, history: History, windowStart: number): number {
  let best = Infinity;
  for (const team of [m.homeTeamId, m.awayTeamId]) {
    if (team == null) continue;
    const h = history.get(team);
    if (!h) continue;
    best = Math.min(best, windowStart - h.lastStartHours);
  }
  return best;
}

interface GapCheck {
  gapHours: number;
  /** 两连主（上一场主场、本场也主场）可降到 48h */
  exempt: boolean;
}

function gapFor(m: SchedMatch, history: History, startHours: number): GapCheck {
  let gap = Infinity;
  let exempt = true;
  let seen = 0;
  for (const [team, isHome] of [
    [m.homeTeamId, true],
    [m.awayTeamId, false],
  ] as const) {
    if (team == null) continue;
    const h = history.get(team);
    if (!h) continue;
    seen += 1;
    gap = Math.min(gap, startHours - h.lastStartHours);
    if (!(h.lastWasHome && isHome)) exempt = false;
  }
  return { gapHours: seen === 0 ? Infinity : gap, exempt: seen > 0 && exempt };
}

/** 排一个窗口：返回每场的 week/day/time 与冲突清单 */
export function scheduleWindow(input: ScheduleInput): ScheduleResult {
  const conflicts: Conflict[] = [];
  const assignments: Assignment[] = [];
  const history: History = new Map(input.history);
  const windowStart = absHours(input.week, input.dayStart, "00:00");
  const days = splitByDay(input.matches, input.dayStart, input.dayEnd);

  for (const { day, matches } of days) {
    const slots = [...(input.pool[day] ?? [])].sort(
      (a, b) => parseTime(b.time) - parseTime(a.time)
    );
    const used = new Map<string, number>();
    if (slots.length === 0) {
      for (const m of matches) {
        conflicts.push({ matchId: m.id, level: "hard", reason: `${input.week} 周没有可用档位` });
      }
      continue;
    }

    // 越疲劳越先排（先排的人拿晚档）；同疲劳按 match.id 稳定
    const ordered = [...matches].sort((a, b) => {
      const fa = fatigueOf(a, history, windowStart);
      const fb = fatigueOf(b, history, windowStart);
      if (fa !== fb) return fa - fb;
      return a.id - b.id;
    });

    for (const m of ordered) {
      const candidates = slots.filter((s) => (used.get(s.time) ?? 0) < s.cap);
      if (candidates.length === 0) {
        conflicts.push({ matchId: m.id, level: "hard", reason: `${input.week} 周 ${day} 日档位已满` });
        continue;
      }

      let picked: Slot | null = null;
      // 1) 满足软约束（64h；两连主 48h）的最晚档
      for (const s of candidates) {
        const { gapHours, exempt } = gapFor(m, history, absHours(input.week, day, s.time));
        if (gapHours >= (exempt ? MIN_GAP_HOURS : SOFT_GAP_HOURS)) {
          picked = s;
          break;
        }
      }
      // 2) 放宽到硬约束
      if (!picked) {
        for (const s of candidates) {
          const { gapHours, exempt } = gapFor(m, history, absHours(input.week, day, s.time));
          if (gapHours >= MIN_GAP_HOURS) {
            picked = s;
            conflicts.push({
              matchId: m.id,
              level: "soft",
              reason: `${gapHours.toFixed(1)}h < 64h（${exempt ? "两连主" : "非两连主"}）`,
            });
            break;
          }
        }
      }
      // 3) 硬约束也不满足：仍落最晚空档，但记账，不静默违规
      if (!picked) {
        picked = candidates[0];
        const gap = gapFor(m, history, absHours(input.week, day, picked.time)).gapHours;
        conflicts.push({
          matchId: m.id,
          level: "hard",
          reason: `${gap === Infinity ? "∞" : gap.toFixed(1)}h < 48h`,
        });
      }

      used.set(picked.time, (used.get(picked.time) ?? 0) + 1);
      assignments.push({ matchId: m.id, week: input.week, day, time: picked.time });

      // 排完就写进历史：同窗口后续场次（补赛/跨腿）才有参照
      const start = absHours(input.week, day, picked.time);
      for (const [team, isHome] of [
        [m.homeTeamId, true],
        [m.awayTeamId, false],
      ] as const) {
        if (team == null) continue;
        history.set(team, { lastStartHours: start, lastWasHome: isHome });
      }
    }
  }

  assignments.sort((a, b) => a.matchId - b.matchId);
  return { assignments, conflicts };
}

export interface PlacedMatch extends SchedMatch {
  week: number | null;
  day: number | null;
  time: string | null;
}

export interface Violation {
  matchId: number;
  level: "hard" | "soft";
  reason: string;
}

/** 体检：对已经落库的排期逐项验证（GET 接口用） */
export function validatePlacement(
  placed: PlacedMatch[],
  options: { week: number; dayStart: number; dayEnd: number; pool: Record<number, Slot[]> }
): Violation[] {
  const out: Violation[] = [];
  const timesOf = (day: number) => new Set((options.pool[day] ?? []).map((s) => s.time));
  const capUsed = new Map<string, number>();

  for (const m of placed) {
    if (m.week == null || m.day == null || m.time == null) {
      out.push({ matchId: m.id, level: "hard", reason: "还没有开球时刻" });
      continue;
    }
    if (m.week !== options.week) {
      out.push({ matchId: m.id, level: "hard", reason: `周次 ${m.week} 不在窗口 ${options.week}` });
    }
    if (m.day < options.dayStart || m.day > options.dayEnd) {
      out.push({
        matchId: m.id,
        level: "hard",
        reason: `第 ${m.day} 天不在窗口 ${options.dayStart}–${options.dayEnd}`,
      });
    }
    if (!timesOf(m.day).has(m.time)) {
      out.push({ matchId: m.id, level: "hard", reason: `时刻 ${m.time} 不在第 ${m.day} 天的池子` });
    }
    const key = `${m.day}|${m.time}`;
    capUsed.set(key, (capUsed.get(key) ?? 0) + 1);
  }

  for (const [key, n] of capUsed) {
    const [day, time] = key.split("|");
    const slot = (options.pool[Number(day)] ?? []).find((s) => s.time === time);
    // 时间不在池子里的已经在上面逐场报过，这里不再叠一条「容量 1/0」
    if (!slot || n <= slot.cap) continue;
    out.push({ matchId: 0, level: "hard", reason: `第 ${day} 天 ${time} 档超出容量 ${n}/${slot.cap}` });
  }

  const byTeam = new Map<number, PlacedMatch[]>();
  for (const m of placed) {
    for (const t of [m.homeTeamId, m.awayTeamId]) {
      if (t == null || m.week == null || m.day == null || m.time == null) continue;
      byTeam.set(t, [...(byTeam.get(t) ?? []), m]);
    }
  }
  for (const [team, list] of byTeam) {
    const sorted = list
      .map((m) => ({ m, at: absHours(m.week!, m.day!, m.time!) }))
      .sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].at - sorted[i - 1].at;
      if (gap < MIN_GAP_HOURS) {
        out.push({
          matchId: sorted[i].m.id,
          level: "hard",
          reason: `队伍 ${team} 间隔 ${gap.toFixed(1)}h < 48h`,
        });
      } else if (gap < SOFT_GAP_HOURS) {
        out.push({
          matchId: sorted[i].m.id,
          level: "soft",
          reason: `队伍 ${team} 间隔 ${gap.toFixed(1)}h < 64h`,
        });
      }
    }
  }
  return out;
}
