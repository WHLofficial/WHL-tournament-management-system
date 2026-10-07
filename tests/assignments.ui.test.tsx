// @vitest-environment jsdom
// 定位球编排页（/tactics/assignments）：深链定位、半场板钉子 ↔ 右侧候选栏双向联动、
// 点人即写回与战术页共用的那份草稿、互斥撞车与「也填了」标记、窄屏落到槽位列表不画板。
// 沿用 tests/assignSheet.ui.test.tsx 的手搓根节点范式（仓库未装 @testing-library）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));
// useAuth 的返回对象必须是稳定引用：页面把它当 effect 依赖，每次新建对象会反复重取
const USER = {
  id: 1,
  name: "教练甲",
  role: "coach",
  teamId: 7,
  locked: false,
  mustChangePassword: false,
};
vi.mock("../src/auth", () => ({
  useAuth: () => ({
    user: USER,
    loading: false,
    authMode: "shared",
    authHome: null,
    refresh: async () => {},
    applyUser: () => {},
    logout: async () => {},
  }),
}));

import Assignments from "../src/pages/Assignments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

// 11 人首发（3142 的 lid 顺序：11,10,9,8,5,7,6,4,3,2,1），身高只给两人，排序才看得出来
const ROSTER = [
  { id: 101, name: "王一", number: "1", height: 190 },
  { id: 102, name: "李二", number: "2", height: 178 },
  { id: 103, name: "张三", number: "3", height: 178 },
  { id: 104, name: "赵四", number: "4", height: 178 },
  { id: 105, name: "钱五", number: "5", height: 178 },
  { id: 106, name: "孙六", number: "6", height: 178 },
  { id: 107, name: "周七", number: "7", height: 178 },
  { id: 108, name: "吴八", number: "8", height: 178 },
  { id: 109, name: "郑九", number: "9", height: 178 },
  { id: 110, name: "Toni Kroos", number: "10", height: 196 },
  { id: 111, name: "陈十一", number: "11", height: 178 },
];
const LIDS = [11, 10, 9, 8, 5, 7, 6, 4, 3, 2, 1];

function seedDraft(assign?: Record<string, number>) {
  window.localStorage.setItem("ftc26-state-v1", JSON.stringify({ form: "3142", bu: "balanced", lh: 50, roles: {} }));
  const names: Record<string, string> = {};
  LIDS.forEach((lid, i) => {
    names[String(lid)] = String(ROSTER[i].id);
  });
  window.localStorage.setItem("ftc26-names-v1", JSON.stringify(names));
  if (assign) window.localStorage.setItem("ftc26-assign-v1", JSON.stringify(assign));
}

beforeEach(() => {
  window.localStorage.clear();
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/api/coach/bootstrap")) {
      return Promise.resolve({
        team: { name: "测试队", players: ROSTER.map(({ id, name, number }) => ({ id, name, number })) },
        matches: [
          {
            id: 21,
            tournamentId: 5,
            tournamentName: "春季联赛",
            stageName: "第一轮",
            stageKind: "elim",
            round: 1,
            leg: null,
            side: "home",
            opponentName: "对手队",
            submitted: false,
            proxyGranted: false,
          },
        ],
      });
    }
    if (path.includes("/lineup")) {
      return Promise.resolve({
        lineup: {
          teamId: 7,
          teamName: "测试队",
          form: "3142",
          submittedAt: null,
          submittedBy: null,
          viaProxy: false,
          starters: ROSTER.map((p, i) => ({
            kind: "starter" as const,
            lid: LIDS[i],
            position: "ST",
            playerId: p.id,
            name: p.name,
            number: p.number,
            meta: { height: p.height },
          })),
          bench: [],
          assign: [],
        },
      });
    }
    if (path.startsWith("/api/coach/me/status")) {
      return Promise.resolve({
        tournaments: [],
        tournamentId: 5,
        yellowThreshold: 3,
        players: [{ playerId: 103, playerName: "张三", remaining: 0, yellows: 0 }],
        injuries: [{ playerId: 102, misses: [{ status: "pending" }, { status: "finished" }] }],
      });
    }
    return Promise.reject(new Error(`未预期的请求：${path}`));
  });
});

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  host?.remove();
  host = null;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountAt(search: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/tactics/assignments${search}`]}>
        <Assignments />
      </MemoryRouter>,
    );
  });
  await flush();
  await flush();
}

function text(sel: string): string {
  return host!.querySelector(sel)?.textContent ?? "";
}

function nodes<T extends HTMLElement = HTMLElement>(sel: string): T[] {
  return [...host!.querySelectorAll<T>(sel)];
}

function byText<T extends HTMLElement = HTMLElement>(sel: string, s: string): T {
  const hit = nodes<T>(sel).find((n) => n.textContent?.includes(s));
  if (!hit) throw new Error(`找不到 ${sel} 里含「${s}」的元素`);
  return hit;
}

describe("定位球编排页（桌面）", () => {
  it("按深链的 group/key 定位：五个组页签、攻板 7 个钉子、当前槽高亮、候选栏跟着当前槽", async () => {
    seedDraft();
    await mountAt("?scope=ftc26&group=角球进攻&key=ca_near&mid=21");

    expect(nodes(".asg-tab").map((t) => t.textContent)).toEqual([
      "队长0/1",
      "任意球0/4",
      "角球进攻0/7",
      "角球防守0/4",
      "界外球0/2",
    ]);
    expect(text(".asg-tab.on")).toBe("角球进攻0/7");

    const board = host!.querySelector(".asg-board")!;
    expect(board.className).toContain("asg-board-attack");
    expect(board.getAttribute("aria-label")).toBe("角球进攻 半场示意图");
    // 钉子顺序 = ASSIGN_GROUPS 里这一组的 items 顺序，短码在上、下面写「空」
    const nails = nodes(".asg-nail");
    expect(nails.map((n) => text1(n, ".asg-nail-top"))).toEqual([
      "左角",
      "右角",
      "目标",
      "近柱",
      "远柱",
      "弧顶",
      "掩护",
    ]);
    expect(nails.every((n) => n.classList.contains("empty"))).toBe(true);
    const curNail = host!.querySelector<HTMLElement>(".asg-nail.cur")!;
    expect(curNail.getAttribute("aria-label")).toBe("近门柱：空");
    expect(curNail.getAttribute("aria-pressed")).toBe("true");
    expect(curNail.style.left).toBe("31%");
    expect(curNail.style.top).toBe("20%");

    // 右侧常驻候选栏 = 当前槽的描述 + 这一槽的候选
    expect(text(".asg-side-head h2")).toContain("近门柱");
    expect(text(".asg-side-head h2")).toContain("角球进攻 · 抢前点");
    expect(text(".asg-side-now")).toBe("不指定");
    // 相关性排序：身高 196（40 分）在前、190（32 分）第二，其余同分按球衣号升序
    const rows = nodes(".asg-row");
    expect(rows).toHaveLength(12); // 11 名首发 + 恒末位的「不指定」
    expect(rows[0].textContent).toContain("#10");
    expect(rows[0].textContent).toContain("Toni Kroos");
    expect(rows[0].textContent).toContain("身高 196");
    expect(rows[1].textContent).toContain("#1");
    expect(rows[1].textContent).toContain("王一");
    expect(rows[2].textContent).toContain("#2");
    expect(rows[2].textContent).toContain("李二");
    expect(rows[11].textContent).toContain("不指定");
    // 伤停后缀跟战术页同口径：李二剩 1 场（另一条已完结不计）
    expect(byText(".asg-row", "李二").textContent).toContain("🩹伤停 剩1场");
  });

  it("点钉子切当前槽，点候选即写回与战术页共用的草稿，钉子跟着变成姓名", async () => {
    seedDraft({ ca_left: 105 });
    await mountAt("?scope=ftc26&group=角球进攻&key=ca_left&mid=21");

    // 已填的槽：钉子上不是「空」，右侧写明是谁，候选行标出选中
    expect(byText(".asg-nail", "钱五").textContent).toContain("钱五");
    expect(byText(".asg-nail", "钱五").classList.contains("empty")).toBe(false);
    expect(text(".asg-side-now")).toBe("#5 钱五");
    expect(nodes(".asg-row.sel")).toHaveLength(1);
    expect(text(".asg-tab.on")).toBe("角球进攻1/7");

    // 点「远门柱」的钉子 → 当前槽跟着换，候选栏换成远门柱
    act(() => byText(".asg-nail", "远柱").click());
    expect(text(".asg-side-head h2")).toContain("远门柱");
    expect(text(".asg-side-now")).toBe("不指定");
    expect(host!.querySelector(".asg-nail.cur")!.getAttribute("aria-label")).toBe("远门柱：空");

    // 点第一位候选（身高 196）→ 落草稿（战术页读的就是这个键） + 板子/计数/选中态实时刷新
    act(() => nodes(".asg-row")[0].click());
    expect(JSON.parse(window.localStorage.getItem("ftc26-assign-v1")!)).toEqual({ ca_left: 105, ca_far: 110 });
    const nail = byText(".asg-nail", "远柱");
    expect(nail.classList.contains("empty")).toBe(false);
    expect(nail.textContent).toContain("Kroos");
    expect(text(".asg-side-now")).toBe("#10 Kroos");
    expect(text(".asg-tab.on")).toBe("角球进攻2/7");
    expect(nodes(".asg-row.sel")).toHaveLength(1);

    // 点「不指定」把这一槽清掉：草稿里这条键整个删掉
    act(() => nodes(".asg-row").at(-1)!.click());
    expect(JSON.parse(window.localStorage.getItem("ftc26-assign-v1")!)).toEqual({ ca_left: 105 });
    expect(byText(".asg-nail", "远柱").classList.contains("empty")).toBe(true);
  });

  it("互斥撞车整组描红、候选行红字警示；填在别处的球员标「也填了」", async () => {
    seedDraft({ ca_left: 110, ca_target: 110, captain: 101 });
    await mountAt("?scope=ftc26&group=角球进攻&key=ca_left&mid=21");

    expect(text(".tac-warn")).toContain("开角球的人和禁区里抢点的人必须分开");
    expect(text(".asg-tab.bad")).toContain("角球进攻");
    // 撞车的两个槽在板上都描红（钉子的排列顺序 = 组内槽位顺序）
    expect(nodes(".asg-nail.bad").map((n) => text1(n, ".asg-nail-top"))).toEqual(["左角", "目标"]);

    const kroos = byText(".asg-row", "Kroos");
    expect(kroos.classList.contains("sel")).toBe(true);
    expect(text1(kroos, ".asg-warn")).toBe("⚠ 已指定：角球进攻 · 目标球员");
    // 撞互斥的那行不再重复报「也填了」
    expect(kroos.querySelector(".asg-elsewhere")).toBeNull();
    // 只填在队长那一槽的球员：候选人选里标出来，但仍然可选
    expect(text1(byText(".asg-row", "王一"), ".asg-elsewhere")).toBe("也填了：队长");
    expect(byText(".asg-row", "王一").classList.contains("sel")).toBe(false);
  });

  it("切页签换组：队长组没有半场板，只有纯候选列表；换回定位球组板子回来", async () => {
    seedDraft();
    await mountAt("?scope=ftc26&group=角球进攻&key=ca_left&mid=21");

    act(() => byText(".asg-tab", "队长").click());
    expect(host!.querySelector(".asg-board")).toBeNull();
    expect(host!.querySelector(".asg-cols.no-board")).not.toBeNull();
    expect(text(".asg-side-head h2")).toContain("队长");
    // 队长看不了属性（无相关性定义）：候选行连「无数据」那行都不渲染
    expect(nodes(".asg-attrs")).toHaveLength(0);
    expect(nodes(".asg-row")).toHaveLength(12);

    act(() => byText(".asg-tab", "界外球").click());
    expect(text(".asg-side-head h2")).toContain("左侧界外球");
    expect(nodes(".asg-nail").map((n) => text1(n, ".asg-nail-top"))).toEqual(["左线", "右线"]);
    expect(host!.querySelector(".asg-board-defense")).toBeNull();

    act(() => byText(".asg-tab", "角球防守").click());
    expect(host!.querySelector(".asg-board-defense")).not.toBeNull();
    expect(text(".asg-board-cap")).toContain("自家球门");
  });

  it("窄屏（手机）不画半场板，改列这一组的槽位 chip，点 chip 换当前槽", async () => {
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    seedDraft({ ca_left: 110 });
    await mountAt("?scope=ftc26&group=角球进攻&key=ca_left&mid=21");

    expect(host!.querySelector(".asg-board")).toBeNull();
    expect(host!.querySelector(".asg-cols.no-board")).not.toBeNull();
    const chips = nodes(".tac-assign-chip");
    expect(chips).toHaveLength(7);
    // 槽位是奇数：补一个虚线空位占位，两列网格的坐标才不会漂
    expect(nodes(".tac-assign-blank")).toHaveLength(1);
    expect(nodes(".tac-assign-cells > *")).toHaveLength(8);
    expect(chips[0].textContent).toContain("左侧角球");
    expect(chips[0].textContent).toContain("Kroos");
    expect(chips[0].classList.contains("on")).toBe(true);
    expect(chips[1].textContent).toContain("右侧角球");
    expect(chips[1].textContent).toContain("不指定");

    act(() => chips[1].click());
    expect(text(".asg-side-head h2")).toContain("右侧角球");
    expect(chips[1].classList.contains("on")).toBe(true);
  });
  it("阵容还没提交过时候选行照样出胶囊与徽章（FC26 数据来自名册自带的那份 meta）", async () => {
    seedDraft({ ca_left: 101, ca_target: 110 });
    // 首次起草：阵容 DTO 是 null，FC26 数据只能靠名册（worker 随 /bootstrap 下发的裁剪版）
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/api/coach/bootstrap")) {
        return Promise.resolve({
          team: {
            name: "测试队",
            players: ROSTER.map(({ id, name, number, height }) => ({
              id,
              name,
              number,
              // attrs 只留战术页读得到的键，另外混一个读不到的（shotpower）看它会不会漏成胶囊
              meta: {
                height,
                attrs: { headingaccuracy: 80, shotpower: 99 },
                playstyles: id === 110 ? [5, 105] : [5],
              },
            })),
          },
          matches: [
            {
              id: 21,
              tournamentId: 5,
              tournamentName: "春季联赛",
              stageName: "第一轮",
              stageKind: "elim",
              round: 1,
              leg: null,
              side: "home",
              opponentName: "对手队",
              submitted: false,
              proxyGranted: false,
            },
          ],
        });
      }
      if (path.includes("/lineup")) return Promise.resolve({ lineup: null });
      if (path.startsWith("/api/coach/me/status")) {
        return Promise.resolve({
          tournaments: [],
          tournamentId: 5,
          yellowThreshold: 3,
          players: [],
          injuries: [],
        });
      }
      return Promise.reject(new Error(`未预期的请求：${path}`));
    });
    await mountAt("?scope=ftc26&group=角球进攻&key=ca_left&mid=21");

    expect(nodes(".asg-row")).toHaveLength(12);
    // 修的就是这一条：此前没有阵容 DTO 时全员「无数据」
    expect(nodes(".asg-nodata")).toHaveLength(0);
    const kroos = byText(".asg-row", "Kroos");
    // 胶囊照 ASSIGN_RELEVANCE 的属性顺序，缺的跳过；读不到的键不出现
    expect([...kroos.querySelectorAll(".asg-pill")].map((n) => n.textContent)).toEqual(["身高 196", "头球 80"]);
    // 徽章：金徽优先（Kroos 有 105），其余只有银徽
    expect(text1(kroos, ".asg-chip.gold")).toBe("精准头球 +");
    expect(text1(byText(".asg-row", "王一"), ".asg-chip.silver")).toBe("精准头球");

    // 板上钉子 ↔ 候选行双向高亮：鼠标停在钉子上，对应的那一行描亮
    const kroosNail = byText(".asg-nail", "Kroos");
    act(() => {
      kroosNail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(kroos.classList.contains("hot")).toBe(true);
    expect(nodes(".asg-row.hot")).toHaveLength(1);
    act(() => {
      kroosNail.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(kroos.classList.contains("hot")).toBe(false);
    // 反过来：鼠标停在候选行上，板上这个人的钉子描亮；移开就熄
    act(() => {
      kroos.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(kroosNail.classList.contains("hot")).toBe(true);
    act(() => {
      kroos.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(kroosNail.classList.contains("hot")).toBe(false);
  });

  it("深链以 key 的组归属为准：key 属于哪组就落哪组，不是看 group 参数", async () => {
    seedDraft();
    await mountAt("?scope=ftc26&group=界外球&key=ca_near&mid=21");

    expect(text(".asg-tab.on")).toBe("角球进攻0/7");
    expect(host!.querySelector(".asg-nail.cur")!.getAttribute("aria-label")).toBe("近门柱：空");
  });

  it("深链的 key 认不出时退回 group 参数那一组的第一项", async () => {
    seedDraft();
    await mountAt("?scope=ftc26&group=界外球&key=bogus&mid=21");

    expect(text(".asg-tab.on")).toBe("界外球0/2");
    expect(host!.querySelector(".asg-nail.cur")!.getAttribute("aria-label")).toBe("左侧界外球：空");
  });
});

function text1(el: HTMLElement, sel: string): string {
  return el.querySelector(sel)?.textContent ?? "";
}
