// @vitest-environment jsdom
// 显示时区偏好层（移植自 club 仓 v6.25.0 的 web/src/lib/datetime.test.tsx）。
// 核心断言都钉在两个确定档（北京 / UTC）上；system 档 CI 时区不定，只烟测不串具体值。
// 本仓没装 @testing-library/react，订阅组件的重渲染用 react 的 act + react-dom/client 手搓根节点。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fmtDate, fmtDateLong, fmtDateShort, fmtDateTime, fmtTime, getTzPref, setTzPref, shanghaiDateStr, tzLabel, useTzPref } from "../src/lib/datetime";

// React 19 的 act 需要这个全局标记，否则只出警告不出错；显式打开
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe() {
  const pref = useTzPref();
  return <span>{pref}</span>;
}

/** 挂载 Probe 并返回读取当前渲染文本的函数 */
function mountProbe(): () => string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return () => host?.textContent ?? "";
}

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

describe("fmtDateTime（确定性格式）", () => {
  it("默认档 = 北京时间：UTC 13:00 → 21:00，短横线格式", () => {
    expect(getTzPref()).toBe("asia/shanghai");
    expect(fmtDateTime("2026-10-03T13:00:00Z")).toBe("2026-10-03 21:00");
  });

  it("utc 档 = 原样钟面", () => {
    setTzPref("utc");
    expect(fmtDateTime("2026-10-03T13:00:00Z")).toBe("2026-10-03 13:00");
  });

  it("跨日进位：23:59 与次日 00:01 边界不串日", () => {
    expect(fmtDateTime("2026-10-03T15:59:00Z")).toBe("2026-10-03 23:59");
    expect(fmtDateTime("2026-10-03T16:01:00Z")).toBe("2026-10-04 00:01");
  });

  it("fmtTime / fmtDate 口径", () => {
    setTzPref("utc");
    expect(fmtTime("2026-10-03T13:05:00Z")).toBe("10-03 13:05");
    expect(fmtDate("2026-10-03T13:05:00Z")).toBe("2026-10-03");
  });

  it("非法与空输入统一回 —（不许抛错或回原串）", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("")).toBe("—");
    expect(fmtDateTime("not-a-date")).toBe("—");
    expect(fmtTime("not-a-date")).toBe("—");
    expect(fmtDate(null)).toBe("—");
  });
});

describe("扩展格式（头版长日期 / 周报短日期 / 上海日历日）", () => {
  it("fmtDateLong：默认北京档输出 YYYY 年 M 月 D 日 星期X，跟随偏好跨日", () => {
    expect(fmtDateLong("2026-10-03T16:30:00Z")).toBe("2026 年 10 月 4 日 星期日");
    setTzPref("utc");
    expect(fmtDateLong("2026-10-03T16:30:00Z")).toBe("2026 年 10 月 3 日 星期六");
  });

  it("fmtDateShort：MM-DD；非法/空回 —", () => {
    setTzPref("utc");
    expect(fmtDateShort("2026-10-03T13:05:00Z")).toBe("10-03");
    expect(fmtDateShort(null)).toBe("—");
    expect(fmtDateShort("not-a-date")).toBe("—");
  });

  it("shanghaiDateStr：+8h 取日期，16:00:00Z 跨到次日；与展示偏好无关", () => {
    expect(shanghaiDateStr(Date.parse("2026-10-03T15:59:59Z"))).toBe("2026-10-03");
    expect(shanghaiDateStr(Date.parse("2026-10-03T16:00:00Z"))).toBe("2026-10-04");
    setTzPref("utc");
    expect(shanghaiDateStr(Date.parse("2026-10-03T16:00:00Z"))).toBe("2026-10-04");
  });
});

describe("偏好持久化与事件同步", () => {
  it("setTzPref 写 localStorage，非法存量值回落默认北京", () => {
    setTzPref("utc");
    expect(localStorage.getItem("whl.tz")).toBe("utc");
    localStorage.setItem("whl.tz", "hacker");
    expect(getTzPref()).toBe("asia/shanghai");
  });

  it("本页 setTzPref → whl:tz-change → 订阅组件即时重渲染", () => {
    const text = mountProbe();
    expect(text()).toBe("asia/shanghai");
    act(() => {
      setTzPref("utc");
    });
    expect(text()).toBe("utc");
  });

  it("跨标签页 storage 事件同样驱动重渲染", () => {
    const text = mountProbe();
    act(() => {
      localStorage.setItem("whl.tz", "utc");
      window.dispatchEvent(new StorageEvent("storage", { key: "whl.tz" }));
    });
    expect(text()).toBe("utc");
  });
});

describe("system 档（烟测，不串具体钟面）", () => {
  it("合法值、不等于空串占位", () => {
    setTzPref("system");
    expect(getTzPref()).toBe("system");
    expect(tzLabel("system")).toBe("本机时区");
    const out = fmtDateTime("2026-10-03T13:00:00Z");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(out).not.toBe("—");
  });
});
