// 守卫测试：前端时间显示只走共享时区层 src/lib/datetime.ts（时区偏好三档，默认北京）。
//
// 背景：收敛之前 src/ 里有三种并存的时间写法——裸切片 `iso.slice(0, 16).replace('T', ' ')`
// （恒 UTC，换显示时区后就是错的）、浏览器本地 `toLocaleString()/getHours()`（随设备漂移）、
// 以及 AuditLog 的 `.slice(0, 19).replace('T', ' ')` 变体。全部收敛到 datetime.ts
// （commit 805b99c；审计筛选的时间解析另按北京时间修正，commit 9b70f59）之后，这里锁两条不变量：
//   1. Intl.DateTimeFormat / timeZone: 只允许出现在 datetime.ts —— 时区口径单点化，别的文件
//      各写各的 Intl 就等于把三种写法换个地方复发；
//   2. 裸切片模式清零 —— `.slice(0, 16).replace(`、`.slice(0, 19).replace(` 与 `.slice(5, 16)`
//      三个精确模式，误伤面最小（正常代码不会恰好这么切）。注意 `.slice(0, 16)` 本身不禁：别的
//      字段真要取前缀属于合法用途，禁的是「把 ISO 时间戳当 UTC 字符串切」的完整形态。
// 判据按行扫描并报文件:行号，宁枉勿纵：命中只会让人来看一眼，放行才是事故。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCAN_ROOTS = ['src'];
const SCAN_EXT = ['.ts', '.tsx'];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return SCAN_EXT.some((ext) => e.name.endsWith(ext)) ? [p] : [];
  });
}

/** 逐行收集命中模式的 文件:行号 内容，失败时直接可读 */
function offenders(files: string[], pattern: RegExp): string[] {
  return files.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => pattern.test(line))
      .map(([n, line]) => `${f}:${n} ${line.trim()}`),
  );
}

const allFiles = SCAN_ROOTS.flatMap(walk);
const nonDatetime = allFiles.filter((f) => !f.includes('datetime'));

describe('前端时间显示单点化（共享时区偏好层）', () => {
  it('Intl.DateTimeFormat / timeZone: 只出现在 lib/datetime.ts', () => {
    expect(offenders(nonDatetime, /Intl\.DateTimeFormat|timeZone\s*:/)).toEqual([]);
  });

  it('裸 UTC 切片清零：.slice(0, 16).replace / .slice(0, 19).replace 与 .slice(5, 16) 全量不再出现', () => {
    expect(offenders(allFiles, /\.slice\(0,\s*(16|19)\)\s*\.replace\(|\.slice\(5,\s*16\)/)).toEqual([]);
  });

  it('判据自检：模式确实能命中目标写法（防正则失效空转）', () => {
    expect(/Intl\.DateTimeFormat|timeZone\s*:/.test("new Intl.DateTimeFormat('zh-CN')")).toBe(true);
    expect(/Intl\.DateTimeFormat|timeZone\s*:/.test('timeZone: zoneOf(pref)')).toBe(true);
    expect(/Intl\.DateTimeFormat|timeZone\s*:/.test('const slice = arr.slice(0, 16);')).toBe(false);
    expect(/\.slice\(0,\s*(16|19)\)\s*\.replace\(|\.slice\(5,\s*16\)/.test("iso.slice(0, 16).replace('T', ' ')")).toBe(true);
    expect(/\.slice\(0,\s*(16|19)\)\s*\.replace\(|\.slice\(5,\s*16\)/.test("iso.slice(0, 19).replace('T', ' ')")).toBe(true);
    expect(/\.slice\(0,\s*(16|19)\)\s*\.replace\(|\.slice\(5,\s*16\)/.test("iso.slice(5, 16)")).toBe(true);
    expect(/\.slice\(0,\s*(16|19)\)\s*\.replace\(|\.slice\(5,\s*16\)/.test('iso.slice(0, 10)')).toBe(false);
  });
});
