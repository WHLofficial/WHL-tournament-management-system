// 显示时区偏好层（移植自 club 仓 v6.25.0）：存储口径不动（各仓一律 UTC ISO TEXT），这里只管「怎么显示」。
// 偏好存 localStorage，三档：北京时间（默认）/ UTC / 跟随浏览器；同页切换走自定义事件、
// 跨标签页走 storage 事件，消费端必须用 useTimeFmt() 订阅，不许只 import 裸函数直读 localStorage。
import { useEffect, useMemo, useState } from 'react';

export type TzPref = 'asia/shanghai' | 'utc' | 'system';

const KEY = 'whl.tz';
const DEFAULT: TzPref = 'asia/shanghai';

/** 偏好变化事件名：setTzPref 派发，useTzPref 监听 */
export const TZ_CHANGE_EVENT = 'whl:tz-change';

export function getTzPref(): TzPref {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'utc' || raw === 'system') return raw;
  } catch {
    // jsdom / 隐私模式取不到 localStorage = 默认北京
  }
  return DEFAULT;
}

export function setTzPref(v: TzPref): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // 写不进去只影响本次会话，切换照常生效
  }
  window.dispatchEvent(new CustomEvent(TZ_CHANGE_EVENT));
}

export function tzLabel(pref: TzPref): string {
  return pref === 'utc' ? 'UTC' : pref === 'system' ? '本机时区' : '北京时间';
}

/** Intl 的 timeZone 参数；system 档不传 = Intl 默认走本机时区 */
function zoneOf(pref: TzPref): string | undefined {
  if (pref === 'system') return undefined;
  return pref === 'utc' ? 'UTC' : 'Asia/Shanghai';
}

// formatter 按 pref+opts 缓存：Intl.DateTimeFormat 构造贵，切档/同档重复渲染不该重建
const cache = new Map<string, Intl.DateTimeFormat>();

function parts(ms: number, opts: Intl.DateTimeFormatOptions) {
  const pref = getTzPref();
  const key = `${pref}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('zh-CN', { ...opts, timeZone: zoneOf(pref), hourCycle: 'h23' });
    cache.set(key, f);
  }
  const get = (type: string) => f!.formatToParts(ms).find((x) => x.type === type)?.value ?? '';
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

type Join = (p: ReturnType<typeof parts>) => string;

function fmtIn(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions, join: Join): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return join(parts(ms, opts));
}

const D = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
const HM = { hour: '2-digit', minute: '2-digit' } as const;

/** YYYY-MM-DD HH:mm */
export function fmtDateTime(iso: string | null | undefined): string {
  return fmtIn(iso, { ...D, ...HM }, (p) => `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}`);
}

/** MM-DD HH:mm（表格行等窄处，年份由页面语境给）——parts 仍取全年历，只是不拼年 */
export function fmtTime(iso: string | null | undefined): string {
  return fmtIn(iso, { ...D, ...HM }, (p) => `${p.mo}-${p.d} ${p.h}:${p.mi}`);
}

/** YYYY-MM-DD */
export function fmtDate(iso: string | null | undefined): string {
  return fmtIn(iso, D, (p) => `${p.y}-${p.mo}-${p.d}`);
}

export function useTzPref(): TzPref {
  const [pref, setPref] = useState<TzPref>(() => getTzPref());
  useEffect(() => {
    const sync = () => setPref(getTzPref());
    window.addEventListener(TZ_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TZ_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return pref;
}

export interface TimeFmt {
  label: string;
  time: (iso: string | null | undefined) => string;
  dateTime: (iso: string | null | undefined) => string;
  date: (iso: string | null | undefined) => string;
}

/** 消费端唯一入口：渲染时间的组件必须走这个 hook（pref 变化即重渲染） */
export function useTimeFmt(): TimeFmt {
  const pref = useTzPref();
  return useMemo<TimeFmt>(
    () => ({
      label: tzLabel(pref),
      time: fmtTime,
      dateTime: fmtDateTime,
      date: fmtDate,
    }),
    [pref],
  );
}
