// 业务时间口径：存储一律 UTC ISO；面向用户的「业务日历日」按上海日历日（UTC 时刻 +8h 取日期）算。
// 参照 club 仓 src/core/market-rules.ts 的 shanghaiDateStr，跨仓口径一致。

const TZ_MS = 8 * 3600_000;

/** 某时刻的上海日历日（YYYY-MM-DD） */
export function shanghaiDateStr(ms: number): string {
  return new Date(ms + TZ_MS).toISOString().slice(0, 10);
}

/** ISO 时刻 → 上海日历日；空/非法输入回退空串（与各消费点既有回退一致） */
export function shanghaiDateOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? "" : shanghaiDateStr(ms);
}

/**
 * 上海日历日 00:00 对应的 UTC 时刻（ISO，形如 2026-10-04T16:00:00.000Z）。
 * 上海周一 00:00 = UTC 周日 16:00；供 SQL 里与 finished_at 的 UTC ISO 字符串比较用。
 */
export function shanghaiMidnightISO(dateStr: string): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - TZ_MS).toISOString();
}
