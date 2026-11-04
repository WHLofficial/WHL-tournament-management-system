// 开球时刻的展示口径（虚拟时刻：赛季第几周 / 周几 / HH:MM）。
// 周几只做标签，不换算真实日期 —— tour 里没有赛季起止日，也没有时区。

const WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"];

/** 1–7 → 一…日；越界返回空串（脏数据时宁可不显示周几） */
export function weekdayCn(day: number | null | undefined): string {
  if (!day || day < 1 || day > 7) return "";
  return WEEKDAY_CN[day - 1];
}

/** 完整写法：「第 5 周 · 周六 17:30」；缺任一项返回 null */
export function kickoffText(
  week: number | null | undefined,
  day: number | null | undefined,
  time: string | null | undefined,
): string | null {
  if (!week || !day || !time) return null;
  const wd = weekdayCn(day);
  return wd ? `第 ${week} 周 · 周${wd} ${time}` : `第 ${week} 周 · ${time}`;
}

/** 分享卡上的紧凑写法：「W5 周六 17:30」 */
export function kickoffShort(
  week: number | null | undefined,
  day: number | null | undefined,
  time: string | null | undefined,
): string | null {
  if (!week || !day || !time) return null;
  const wd = weekdayCn(day);
  return wd ? `W${week} 周${wd} ${time}` : `W${week} ${time}`;
}
