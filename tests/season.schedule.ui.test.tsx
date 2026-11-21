// @vitest-environment jsdom
// 赛季排期一级页（/admin/seasons/:seasonId/schedule）：
//   赛历视图（默认工作台）：31 周卡墙、inline 详情、Esc 清选中；
//   宽屏总览：31 列矩阵 + 全季尺 + inspector + 三套排法 + 版本轨道 + 冲突弹层；
//   三态（骨架/错误重试/空态）、视图互切、深链下钻（High-1：跨赛事 14 号）、
//   旧 KickoffTab 的单段下钻与放行通道用例原样保留。
// 工具与 fixtures 从 tests/season.overview.ui.test.tsx 原样迁移（手搓 createRoot，仓库未装 @testing-library）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router";
import { SeasonSchedulePage } from "../src/pages/season/SeasonSchedulePage";
import { BoardView } from "../src/pages/season/BoardView";
import KickoffTab from "../src/pages/KickoffTab";
import { TournamentManage } from "../src/pages/TournamentManage";
import type { TournamentDetailDTO } from "../shared/types";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: apiMock };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// —— 夹具：两个赛事（联赛 2 段 + 杯赛 2 段），一段绿、一段黄（待排）、一段红（硬冲突）、一段灰（锁定） ——
const DETAIL = {
  tournament: {
    id: 13,
    name: "S9 | 顶级联赛",
    description: null,
    format: "round_robin",
    status: "running",
    createdAt: "2026-11-01T00:00:00Z",
    entryCount: 8,
    coverUrl: null,
  },
  stages: [],
  groups: [],
  entries: [],
} as unknown as TournamentDetailDTO;

// TournamentManage 深链用例：路由是 /admin/t/14，详情按 14 号赛事给
const DETAIL14 = {
  ...DETAIL,
  tournament: { ...DETAIL.tournament, id: 14, name: "S9 | 冠军杯" },
} as unknown as TournamentDetailDTO;

function overviewFixture() {
  return {
    season: { id: 1, name: "S9", weeks: 31 },
    counts: { segments: 4, matches: 12, scheduled: 10, unscheduled: 2, unmatched: 1 },
    segments: [
      {
        id: 201,
        tournamentId: 13,
        tournamentName: "S9 | 顶级联赛",
        competition: "top",
        stream: "league",
        round: 1,
        leg: null,
        week: 1,
        dayStart: 6,
        dayEnd: 7,
        lockedAt: null,
        hasOverride: false,
        matchCount: 4,
        scheduledCount: 4,
        playableCount: 4,
      },
      {
        id: 202,
        tournamentId: 13,
        tournamentName: "S9 | 顶级联赛",
        competition: "top",
        stream: "league",
        round: 2,
        leg: null,
        week: 2,
        dayStart: 6,
        dayEnd: 7,
        lockedAt: null,
        hasOverride: false,
        matchCount: 4,
        scheduledCount: 2,
        playableCount: 4,
      },
      {
        id: 211,
        tournamentId: 14,
        tournamentName: "S9 | 冠军杯",
        competition: "cup",
        stream: "group",
        round: 1,
        leg: null,
        week: 2,
        dayStart: 2,
        dayEnd: 3,
        lockedAt: null,
        hasOverride: false,
        matchCount: 4,
        scheduledCount: 4,
        playableCount: 4,
      },
      {
        id: 214,
        tournamentId: 14,
        tournamentName: "S9 | 冠军杯",
        competition: "cup",
        stream: "elim",
        round: 2,
        leg: 1,
        week: 8,
        dayStart: 2,
        dayEnd: 3,
        lockedAt: "2026-11-01T00:00:00Z",
        hasOverride: false,
        matchCount: 2,
        scheduledCount: 2,
        playableCount: 2,
      },
    ],
    placements: [
      { matchId: 101, segmentId: 201, week: 1, day: 6, time: "17:30", override: false, reason: null },
    ],
    unmatchedMatchIds: [157],
    savedSegmentIds: [202],
    violations: [
      { matchId: 141, level: "hard", reason: "队伍 1 间隔 40.0h < 48h", teamId: 1, segmentId: 211 },
      { matchId: 142, level: "soft", reason: "队伍 2 间隔 60.0h < 64h（非两连主）", teamId: 2, segmentId: 211 },
      { matchId: 105, level: "report", reason: "队伍 3 间隔 68.0h < 72h（备用报告）", teamId: 3, segmentId: 202 },
    ],
    revisions: [
      {
        id: 2,
        seasonId: 1,
        revision: 2,
        hash: "c".repeat(64),
        status: "published",
        lockedAt: "2026-11-19T09:00:00Z",
        createdBy: "管理员",
        createdAt: "2026-11-19T09:00:00Z",
        metrics: { segments: 4, matches: 12, scheduled: 10, unmatchedMatchIds: [], hard: 0, soft: 1 },
        note: null,
        assignmentCount: 10,
      },
      {
        id: 1,
        seasonId: 1,
        revision: 1,
        hash: "a".repeat(64),
        status: "committed",
        lockedAt: null,
        createdBy: "管理员",
        createdAt: "2026-11-18T09:00:00Z",
        metrics: { segments: 4, matches: 12, scheduled: 8, unmatchedMatchIds: [157], hard: 1, soft: 0 },
        note: "整季提交",
        assignmentCount: 8,
      },
    ],
  };
}

const HASH_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function previewFixture() {
  return {
    ok: true,
    seasonId: 1,
    segmentIds: [201, 202, 211, 214],
    totalSegments: 4,
    blockedSegmentIds: [],
    unplayableMatchIds: [157],
    unplacedMatchIds: [],
    fixed: [
      { matchId: 101, segmentId: 201, week: 1, day: 6, time: "17:30" },
      { matchId: 153, segmentId: 214, week: 8, day: 3, time: "21:00" },
    ],
    candidates: [
      {
        key: "A",
        seed: 42,
        steps: 2000,
        metrics: { hard: 0, soft: 1, report: 2, minGapHours: 66.5, lateRatio: 0.5, maxConsecutiveLoad: 3 },
        violations: [],
        unplacedMatchIds: [],
        hash: HASH_A,
      },
      {
        key: "B",
        seed: 7961,
        steps: 2000,
        metrics: { hard: 0, soft: 2, report: 3, minGapHours: 64.0, lateRatio: 0.57, maxConsecutiveLoad: 3 },
        violations: [],
        unplacedMatchIds: [],
        hash: HASH_B,
      },
      {
        key: "C",
        seed: 15880,
        steps: 2000,
        metrics: { hard: 1, soft: 0, report: 1, minGapHours: 40.0, lateRatio: 0.44, maxConsecutiveLoad: 4 },
        violations: [
          { matchId: 141, level: "hard", reason: "队伍 1 间隔 40.0h < 48h", teamId: 1, segmentId: 211 },
        ],
        unplacedMatchIds: [],
        hash: "f".repeat(64),
      },
    ],
  };
}

function commitFixture() {
  return {
    ok: true,
    revision: {
      id: 9,
      seasonId: 1,
      revision: 3,
      hash: HASH_A,
      status: "committed",
      lockedAt: null,
      createdBy: "管理员",
      createdAt: "2026-11-19T12:00:00Z",
      metrics: { segments: 4, matches: 12, scheduled: 11, unmatchedMatchIds: [], hard: 0, soft: 0 },
      note: null,
      assignmentCount: 11,
    },
    applied: 10,
    violations: [],
  };
}

function restoreFixture() {
  return {
    ok: true,
    revision: {
      id: 10,
      seasonId: 1,
      revision: 4,
      hash: "a".repeat(64),
      status: "restored",
      lockedAt: null,
      createdBy: "管理员",
      createdAt: "2026-11-19T12:30:00Z",
      metrics: { segments: 4, matches: 12, scheduled: 8, unmatchedMatchIds: [157], hard: 1, soft: 0 },
      note: "回滚自版本 r1",
      assignmentCount: 8,
    },
    restoredMatchIds: [105, 106],
    skippedMatchIds: [101],
    violations: [],
  };
}

function publishFixture() {
  return { lockedSegmentIds: [211, 214], alreadyPublished: false };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let apiCalls: { path: string; method: string; body?: unknown }[] = [];

function unmountCurrent() {
  const r = root;
  if (r)
    act(() => {
      r.unmount();
    });
  root = null;
  host?.remove();
  host = null;
}

function mount(node: ReactNode) {
  unmountCurrent();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

function text(): string {
  return host?.textContent ?? "";
}

function buttons(): HTMLButtonElement[] {
  return [...(host?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
}

function button(label: string): HTMLButtonElement {
  const found = buttons().find((b) => (b.textContent ?? "").trim() === label);
  if (!found)
    throw new Error(
      `找不到按钮「${label}」，当前有：${buttons().map((b) => (b.textContent ?? "").trim()).join(" / ")}`,
    );
  return found;
}

// —— 一级页渲染：MemoryRouter + Routes 包住 SeasonSchedulePage 与 TournamentManage（深链用） ——
let lastSearch = "";

function SearchProbe() {
  const [sp] = useSearchParams();
  lastSearch = sp.toString();
  return null;
}

function mountPage(initial = "/admin/seasons/1/schedule") {
  lastSearch = "";
  mount(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/admin/seasons/:seasonId/schedule"
          element={
            <>
              <SeasonSchedulePage />
              <SearchProbe />
            </>
          }
        />
        <Route
          path="/admin/t/:id"
          element={
            <>
              <TournamentManage />
              <SearchProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiCalls = [];
  // 新页面不再调 /tournaments/:tid/windows（seasonId 来自路由）；
  // apiMock 默认只答 /api/admin/seasons/1/schedule*。
  apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
    apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
    if (path === "/api/admin/seasons/1/schedule") return overviewFixture();
    if (path === "/api/admin/seasons/1/schedule/preview") return previewFixture();
    if (path === "/api/admin/seasons/1/schedule/commit") return commitFixture();
    if (path === "/api/admin/seasons/1/schedule/restore/1") return restoreFixture();
    if (path === "/api/admin/seasons/1/schedule/publish") return publishFixture();
    throw new Error(`意外的 api 调用：${path}`);
  });
});

afterEach(() => {
  unmountCurrent();
  vi.restoreAllMocks();
});

/** W 卡里的某个段块（按 gridColumn 定位） */
function calBlock(week: number, gridColumn: string): HTMLElement {
  const card = host!.querySelector(`#cal-week-${week}`)!;
  const found = [...card.querySelectorAll<HTMLElement>(".cal-block")].find(
    (b) => b.style.gridColumn === gridColumn,
  );
  if (!found) throw new Error(`W${week} 里找不到 gridColumn=${gridColumn} 的块`);
  return found;
}

describe("赛季排期页 · 赛历视图（默认工作台）", () => {
  it("默认渲染赛历视图：31 张周卡按 4 周一行（8 个行末分隔）、D1-D7 表头、块按 fixture 落周/日列/lane", async () => {
    mountPage();
    await flush();
    await flush();

    const cards = [...host!.querySelectorAll<HTMLElement>(".cal-week")];
    expect(cards).toHaveLength(31);
    expect(cards.filter((c) => c.className.includes("row-end"))).toHaveLength(8); // 31 周 = 8 行 × 4
    const days = cards[0]!.querySelectorAll(".cal-week-days span");
    expect([...days].map((s) => s.textContent)).toEqual(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
    // 周卡顺序 W1..W31
    expect(cards[0].id).toBe("cal-week-1");
    expect(cards[30].id).toBe("cal-week-31");

    // lane：杯赛（14）第一 lane，联赛（13）第二 lane
    const b201 = calBlock(1, "6 / 8"); // 201 W1 D6-D7，top lane2
    expect(b201.style.gridRow).toBe("2");
    expect(b201.className).toContain("top");
    expect(b201.className).toContain("is-draft");
    const b211 = calBlock(2, "2 / 4"); // 211 W2 D2-D3，cup lane1
    expect(b211.style.gridRow).toBe("1");
    expect(b211.className).toContain("cup");
    // 211 有硬冲突（141）：hard 数字角标优先
    expect(b211.querySelector(".cal-flag.hard")?.textContent).toBe("1");
    // 202 只有 report（105）：report 角标；savedSegmentIds 命中，显示已保存而非草稿
    const b202 = calBlock(2, "6 / 8");
    expect(b202.querySelector(".cal-flag.report")?.textContent).toBe("1");
    expect(b202.className).toContain("is-saved");
    expect(b202.className).not.toContain("is-draft");
    // 214 已公布锁定：is-locked，不再虚线
    const b214 = calBlock(8, "2 / 4");
    expect(b214.className).toContain("is-locked");
    expect(b214.className).not.toContain("is-draft");
  });

  it("点块出 inline 详情（场次/已定/没排时间 + violation reason），插在所在 4 周行末尾，再点收起", async () => {
    mountPage();
    await flush();
    await flush();

    // 201（W1）：有已排场次 #101，无冲突
    await click(calBlock(1, "6 / 8"));
    expect(host!.querySelector(".cal-detail-row")).toBeTruthy();
    expect(host!.querySelector(".cal-detail-row")!.previousElementSibling!.id).toBe("cal-week-4");
    const ins = host!.querySelector(".cal-detail-row")!;
    const stats = [...ins.querySelectorAll(".cal-stat")].map((s) => s.textContent);
    expect(stats).toEqual(["4场次", "4已定", "0没排时间", "0要看的冲突"]);
    expect(ins.querySelector("tbody tr")?.textContent).toContain("#101");
    expect(ins.querySelector("tbody tr")?.textContent).toContain("第 1 周 · 周六 17:30");
    expect(ins.querySelector(".cal-tag.ok")?.textContent).toBe("已定");
    expect(ins.querySelector(".cal-conflict-box")).toBeFalsy();

    // 收起（再点同一块）
    await click(calBlock(1, "6 / 8"));
    expect(host!.querySelector(".cal-detail-row")).toBeFalsy();

    // 211（W2）：硬冲突 141 → conflict-box hard + reason；无已排时刻 → 空表提示
    await click(calBlock(2, "2 / 4"));
    const box = host!.querySelector(".cal-detail-row .cal-conflict")!;
    expect(box.className).toContain("hard");
    expect(box.textContent).toContain("必须解决的时间冲突 1 处");
    expect(box.textContent).toContain("队伍 1 间隔 40.0h < 48h");
    expect(host!.querySelector(".cal-detail-row tbody")?.textContent).toContain("还没有已定的开球档位");
    await click(calBlock(2, "2 / 4"));
    expect(host!.querySelector(".cal-detail-row")).toBeFalsy();
  });

  it("Esc 清掉选中（详情收起）", async () => {
    mountPage();
    await flush();
    await flush();
    await click(calBlock(1, "6 / 8"));
    expect(host!.querySelector(".cal-detail-row")).toBeTruthy();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(host!.querySelector(".cal-detail-row")).toBeFalsy();
  });

  it("视图切换改写 view 查询参数（calendar ↔ board），board 渲染矩阵", async () => {
    mountPage();
    await flush();
    await flush();
    expect(host!.querySelector(".cal-view")).toBeTruthy();

    await click(button("宽屏总览"));
    expect(lastSearch).toBe("view=board");
    expect(host!.querySelector(".season-board")).toBeTruthy();
    expect(host!.querySelector(".cal-view")).toBeFalsy();

    await click(button("赛历视图"));
    expect(lastSearch).toBe("view=calendar");
    expect(host!.querySelector(".cal-view")).toBeTruthy();
  });

  it("空 segments：空态文案 + 去赛事列表链接，不渲染周卡墙", async () => {
    apiMock.mockImplementation(async (path: string) => {
      apiCalls.push({ path, method: "GET" });
      if (path === "/api/admin/seasons/1/schedule")
        return { ...overviewFixture(), segments: [], placements: [], counts: { segments: 0, matches: 0, scheduled: 0, unscheduled: 0, unmatched: 0 } };
      throw new Error(`意外的 api 调用：${path}`);
    });
    mountPage();
    await flush();
    await flush();
    expect(text()).toContain("本赛季还没有轮次安排");
    expect(text()).toContain("去赛事列表");
    expect(host!.querySelector(".cal-week")).toBeFalsy();
  });

  it("错误态：总览拉失败显示错误与重试，恢复后重新渲染", async () => {
    let failing = true;
    apiMock.mockImplementation(async (path: string) => {
      apiCalls.push({ path, method: "GET" });
      if (failing) throw new Error("D1 炸了");
      if (path === "/api/admin/seasons/1/schedule") return overviewFixture();
      throw new Error(`意外的 api 调用：${path}`);
    });
    mountPage();
    await flush();
    await flush();
    expect(text()).toContain("赛季总览加载失败");
    expect(text()).toContain("D1 炸了");
    expect(host!.querySelector(".cal-week")).toBeFalsy();

    failing = false;
    await click(button("重试"));
    expect(host!.querySelector(".cal-week")).toBeTruthy();
    expect(apiCalls.filter((c) => c.path === "/api/admin/seasons/1/schedule").length).toBeGreaterThanOrEqual(2);
  });

  it("加载骨架：保留周卡结构（8 张骨架卡），不用居中 spinner", async () => {
    let resolveOverview: (v: unknown) => void = () => {};
    apiMock.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          if (path === "/api/admin/seasons/1/schedule") {
            resolveOverview = resolve;
            return new Promise(() => {});
          }
          resolve(undefined);
          throw new Error(`意外的 api 调用：${path}`);
        }),
    );
    mountPage();
    await flush();
    expect(host!.querySelectorAll(".sk-week-card")).toHaveLength(8);
    expect(host!.querySelector(".cal-view")).toBeFalsy();
    await act(async () => {
      resolveOverview(overviewFixture());
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(host!.querySelector(".cal-view")).toBeTruthy();
    expect(host!.querySelector(".sk-week-card")).toBeFalsy();
  });
});

describe("赛季排期页 · 宽屏总览", () => {
  it("31 列矩阵 + 全季尺 + inspector；tile 显示场次数/锁 SVG/hard 角标", async () => {
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    expect(host!.querySelectorAll(".sb-week-head")).toHaveLength(31);
    expect(host!.querySelectorAll(".sb-ruler-week")).toHaveLength(31);
    expect(host!.querySelector(".sb-inspector")!.textContent).toContain("点一个格子看详情");

    // tile：201（4 场，全部已定）、202（2/4）、211 硬冲突角标、214 锁 SVG
    const t201 = host!.querySelector('[data-seg="201"]')!;
    expect(t201.querySelector(".sb-count")?.textContent).toBe("4场");
    expect(t201.title).toContain("4/4 已定");
    const t202 = host!.querySelector('[data-seg="202"]')!;
    expect(t202.title).toContain("2/4 已定");
    const t211 = host!.querySelector('[data-seg="211"]')!;
    expect(t211.className).toContain("hard");
    expect(t211.querySelector(".sb-warn")?.textContent).toBe("1 冲突");
    const t214 = host!.querySelector('[data-seg="214"]')!;
    expect(t214.className).toContain("locked");
    expect(t214.querySelector("svg.sb-lock")).toBeTruthy();

    // 全季尺：有 hard 的周（W2）带红线
    expect(host!.querySelectorAll(".sb-ruler-week")[1]!.className).toContain("hard");
  });

  it("矩阵点 tile → inspector 标题 + 三格 stat + 场次表（含 conflict-box）", async () => {
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    await click(host!.querySelector('[data-seg="201"]')!);
    const ins = host!.querySelector(".sb-inspector")!;
    expect(ins.querySelector(".sb-ins-head h2")?.textContent).toBe("来自第 1 周 · 第 1 轮");
    const stats = [...ins.querySelectorAll(".sb-ins-stat")].map((s) => s.textContent);
    expect(stats).toEqual(["4场次", "4已定", "0没排时间"]);
    expect(ins.querySelector("tbody tr")?.textContent).toContain("#101");
    expect(ins.querySelector("tbody tr")?.textContent).toContain("第 1 周 · 周六 17:30");

    await click(host!.querySelector('[data-seg="211"]')!);
    const box = host!.querySelector(".sb-inspector .sb-conflict-box")!;
    expect(box.className).toContain("hard");
    expect(box.textContent).toContain("队伍 1 间隔 40.0h < 48h");
  });

  it("键盘：方向键在矩阵内移动选中（左右 = 段序，上下 = 同周换 lane），Esc 清选中", async () => {
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    const key = (k: string) =>
      act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    const selected = () => host!.querySelectorAll(".sb-tile.selected").length;

    await key("ArrowRight"); // 无选中 → 第一段（cup lane 优先 = 211）
    await flush();
    expect(host!.querySelector(".sb-tile.selected")?.getAttribute("data-seg")).toBe("211");
    await key("ArrowDown"); // 同周换 lane：211 → 202（top）
    await flush();
    expect(host!.querySelector(".sb-tile.selected")?.getAttribute("data-seg")).toBe("202");
    await key("ArrowLeft"); // 段序后退：202 → 201（cup lane 的 W1 无段，序列里 201 在 202 前面）
    await flush();
    expect(host!.querySelector(".sb-tile.selected")?.getAttribute("data-seg")).toBe("201");
    await key("ArrowRight"); // 段序前进：201 → 202
    await flush();
    expect(host!.querySelector(".sb-tile.selected")?.getAttribute("data-seg")).toBe("202");
    await key("Escape");
    await flush();
    expect(selected()).toBe(0);
    expect(host!.querySelector(".sb-inspector")!.textContent).toContain("点一个格子看详情");
  });

  it("看看三套排法弹层三栏 + 指标齐全 + 排法 C 硬冲突禁用「用这套」（沿用旧 403-429 口径）", async () => {
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    await click(button("看看三套排法"));
    const sheets = [...host!.querySelectorAll(".sb-proposal")];
    expect(sheets).toHaveLength(3);
    const titles = sheets.map((c) => c.querySelector(".sb-proposal-top strong")?.textContent ?? "");
    expect(titles).toEqual(["排法 A", "排法 B", "排法 C"]);
    for (const card of sheets) {
      expect(card.textContent).toContain("必须解决");
      expect(card.textContent).toContain("最小间隔");
      expect(card.textContent).toContain("晚场占比");
      expect(card.textContent).toContain("最大连续负荷");
    }
    // 排法 C 有硬冲突：用这套禁用；A/B 可用
    const applyC = sheets[2].querySelector<HTMLButtonElement>(".sb-proposal > button.btn")!;
    expect(applyC.disabled).toBe(true);
    expect(sheets[0].querySelector<HTMLButtonElement>(".sb-proposal > button.btn")!.disabled).toBe(false);

    const previewCall = apiCalls.find((c) => c.path.endsWith("/preview"));
    expect(previewCall?.method).toBe("POST");
    expect(previewCall?.body).toEqual({});
  });

  it("「用这套」提交候选 key+hash 并刷新总览；toast 沿用 msg 文案", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();
    await click(button("看看三套排法"));

    const sheets = [...host!.querySelectorAll(".sb-proposal")];
    await click(sheets[0].querySelector("button.btn")!);

    const commitCall = apiCalls.find((c) => c.path.endsWith("/commit"));
    expect(commitCall?.body).toEqual({ key: "A", hash: HASH_A });
    // 提交后重新拉总览
    expect(apiCalls.filter((c) => c.path === "/api/admin/seasons/1/schedule").length).toBeGreaterThanOrEqual(2);
    // toast（msg 范式）
    expect(host!.querySelector(".season-toast")?.textContent).toContain("已应用方案 A");
    expect(host!.querySelector(".season-toast")?.textContent).toContain("版本 r3");
  });

  it("公布在 hard>0 时 disabled（头部 + 版本卡都禁用并带 title）", async () => {
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    const publish = button("公布");
    expect(publish.disabled).toBe(true);
    expect(publish.title).toContain("还有 1 处时间冲突没解决");
    // 版本卡：r2 已公布（变「补锁」）、r1 提交（公布）都因整季硬冲突禁用；恢复不受影响
    const revBtns = [...host!.querySelectorAll(".sb-rev-ops button")].map((b) => ({
      t: b.textContent,
      d: b.disabled,
      title: b.title,
    }));
    expect(revBtns[0].t).toBe("补锁");
    expect(revBtns[0].d).toBe(true);
    expect(revBtns[2].d).toBe(true);
    expect(revBtns[1].d).toBe(false);
    expect(revBtns[3].d).toBe(false);
    expect(revBtns[0].title).toContain("必须解决");
  });

  it("版本轨道：公布走 publish、恢复走 restore/1（confirm mock），成功后刷新并出 toast", async () => {
    // 整季无硬冲突时公布才可用：把 violations 换成只剩 report
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
      const base = overviewFixture();
      const calm = { ...base, violations: base.violations.filter((v) => v.level === "report") };
      if (path === "/api/admin/seasons/1/schedule") return calm;
      if (path === "/api/admin/seasons/1/schedule/publish") return publishFixture();
      if (path === "/api/admin/seasons/1/schedule/restore/1") return restoreFixture();
      throw new Error(`意外的 api 调用：${path}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    // 头部公布：POST publish body { revision: 2 }（最新版）
    await click(button("公布"));
    const publishCall = apiCalls.find((c) => c.path.endsWith("/publish"));
    expect(publishCall?.method).toBe("POST");
    expect(publishCall?.body).toEqual({ revision: 2 });
    expect(host!.querySelector(".season-toast")?.textContent).toContain("已公布 r2，锁定 2 段");

    // 版本卡恢复：POST restore/1（r1 卡的恢复按钮）
    const restoreBtn = [...host!.querySelectorAll(".sb-rev-item")][1]!.querySelector(".sb-rev-ops button:last-child")!;
    await click(restoreBtn);
    const restoreCall = apiCalls.find((c) => c.path.endsWith("/restore/1"));
    expect(restoreCall?.method).toBe("POST");
    expect(host!.querySelector(".season-toast")?.textContent).toContain("已回滚到 r1");
    expect(host!.querySelector(".season-toast")?.textContent).toContain("写回 2 场");
    expect(host!.querySelector(".season-toast")?.textContent).toContain("跳过 1 场");
  });

  it("冲突弹层「应用建议」：只对该段求解并提交最优候选（segmentId 211）", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    await click(host!.querySelector('[data-seg="211"]')!);
    await click([...host!.querySelectorAll(".sb-link-btn")].find((b) => b.textContent === "看全部冲突")!);
    expect(host!.querySelector(".season-modal-backdrop")).toBeTruthy();
    expect(host!.querySelector(".season-sheet-head h2")!.textContent).toContain("全季时间冲突 · 3 处");

    await click([...host!.querySelectorAll(".sb-conflict-row")][0].querySelector("button")!);
    const previewCall = apiCalls.find((c) => c.path.endsWith("/preview") && (c.body as { segmentIds?: number[] })?.segmentIds);
    expect(previewCall?.body).toEqual({ segmentIds: [211] });
    const commitCall = apiCalls.find((c) => c.path.endsWith("/commit"));
    // 三套候选里 A 最优（硬 0 软 1）
    expect(commitCall?.body).toEqual({ key: "A", hash: HASH_A, segmentIds: [211] });
    expect(host!.querySelector(".season-toast")?.textContent).toContain("已应用建议（方案 A）");
  });

  it("「打开开球时刻」跳转 /admin/t/14?tab=kickoff&segment=211：KickoffTab 选中 211（High-1 等价）", async () => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
      if (path === "/api/admin/seasons/1/schedule") return overviewFixture();
      if (path === "/api/admin/tournaments/14") return DETAIL14;
      if (path === "/api/admin/tournaments/14/standings-health")
        return { ok: true, healthy: true, pending: [], mismatches: [] };
      if (path === "/api/admin/tournaments/14/windows")
        return {
          windows: [
            {
              id: 211,
              seasonId: 1,
              stream: "group",
              round: 1,
              leg: null,
              week: 2,
              dayStart: 2,
              dayEnd: 3,
              lockedAt: null,
              matchCount: 4,
              scheduledCount: 4,
              playableCount: 4,
              hasOverride: false,
            },
            {
              id: 214,
              seasonId: 1,
              stream: "elim",
              round: 2,
              leg: 1,
              week: 8,
              dayStart: 2,
              dayEnd: 3,
              lockedAt: "2026-11-01T00:00:00Z",
              matchCount: 2,
              scheduledCount: 2,
              playableCount: 2,
              hasOverride: false,
            },
          ],
        };
      const m = path.match(/\/api\/admin\/tournaments\/(\d+)\/windows\/(\d+)\/schedule$/);
      if (m)
        return {
          window: {
            id: Number(m[2]),
            stream: "group",
            round: 1,
            leg: null,
            week: 2,
            dayStart: 2,
            dayEnd: 3,
            overridden: false,
            simultaneous: false,
            lockedAt: null,
          },
          matches: [],
          violations: [],
          blocked: null,
        };
      throw new Error(`意外的 api 调用：${path}`);
    });
    mountPage("/admin/seasons/1/schedule?view=board");
    await flush();
    await flush();

    await click(host!.querySelector('[data-seg="211"]')!);
    await click([...host!.querySelectorAll(".sb-ins-actions button")].find((b) => b.textContent === "打开开球时刻")!);
    await flush();
    await flush();

    // 路由真的跳过去了，且 KickoffTab 按段属赛事拉窗口并选中 211
    expect(lastSearch).toContain("tab=kickoff&segment=211");
    expect(lastSearch).toContain("tname=");
    expect(host!.querySelector("select")!.value).toBe("211");
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/14/windows")).toBe(true);
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/14/windows/211/schedule")).toBe(true);
  });
});

describe("TournamentManage 深链：?tab=kickoff&segment=…（等价旧 High-1）", () => {
  beforeEach(() => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
      if (path === "/api/admin/tournaments/14") return DETAIL14;
      if (path === "/api/admin/tournaments/14/standings-health")
        return { ok: true, healthy: true, pending: [], mismatches: [] };
      if (path === "/api/admin/tournaments/14/windows")
        return {
          windows: [
            {
              id: 211,
              seasonId: 1,
              stream: "group",
              round: 1,
              leg: null,
              week: 2,
              dayStart: 2,
              dayEnd: 3,
              lockedAt: null,
              matchCount: 4,
              scheduledCount: 4,
              playableCount: 4,
              hasOverride: false,
            },
            {
              id: 214,
              seasonId: 1,
              stream: "elim",
              round: 2,
              leg: 1,
              week: 8,
              dayStart: 2,
              dayEnd: 3,
              lockedAt: "2026-11-01T00:00:00Z",
              matchCount: 2,
              scheduledCount: 2,
              playableCount: 2,
              hasOverride: false,
            },
          ],
        };
      const m = path.match(/\/api\/admin\/tournaments\/(\d+)\/windows\/(\d+)\/schedule$/);
      if (m)
        return {
          window: {
            id: Number(m[2]),
            stream: "group",
            round: 1,
            leg: null,
            week: 2,
            dayStart: 2,
            dayEnd: 3,
            overridden: false,
            simultaneous: false,
            lockedAt: null,
          },
          matches: [],
          violations: [],
          blocked: null,
        };
      throw new Error(`意外的 api 调用：${path}`);
    });
  });

  it("mount 带 /admin/t/14?tab=kickoff&segment=211&tname=… → KickoffTab 选中 211 且拉 14/windows", async () => {
    mountPage("/admin/t/14?tab=kickoff&segment=211&tname=" + encodeURIComponent("S9 | 冠军杯"));
    await flush();
    await flush();

    expect(host!.querySelector("select")!.value).toBe("211");
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/14/windows")).toBe(true);
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/14/windows/211/schedule")).toBe(true);
    expect(text()).toContain("排期 · 单段下钻");
  });
});

describe("旧 KickoffTab：单段下钻入口（自 season.overview.ui.test.tsx 原样迁移）", () => {
  beforeEach(() => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
      if (path === "/api/admin/tournaments/13/windows")
        return {
          windows: [
            {
              id: 201,
              seasonId: 1,
              stream: "league",
              round: 1,
              leg: null,
              week: 1,
              dayStart: 6,
              dayEnd: 7,
              lockedAt: null,
              matchCount: 4,
              scheduledCount: 4,
              playableCount: 4,
              hasOverride: false,
            },
            {
              id: 202,
              seasonId: 1,
              stream: "league",
              round: 2,
              leg: null,
              week: 2,
              dayStart: 6,
              dayEnd: 7,
              lockedAt: null,
              matchCount: 4,
              scheduledCount: 2,
              playableCount: 4,
              hasOverride: false,
            },
          ],
        };
      // 14 号赛事（冠军杯）的窗口：跨赛事下钻（High-1）用的就是这份清单
      if (path === "/api/admin/tournaments/14/windows")
        return {
          windows: [
            {
              id: 211,
              seasonId: 1,
              stream: "group",
              round: 1,
              leg: null,
              week: 2,
              dayStart: 2,
              dayEnd: 3,
              lockedAt: null,
              matchCount: 4,
              scheduledCount: 4,
              playableCount: 4,
              hasOverride: false,
            },
            {
              id: 214,
              seasonId: 1,
              stream: "elim",
              round: 2,
              leg: 1,
              week: 8,
              dayStart: 2,
              dayEnd: 3,
              lockedAt: "2026-11-01T00:00:00Z",
              matchCount: 2,
              scheduledCount: 2,
              playableCount: 2,
              hasOverride: false,
            },
          ],
        };
      const m = path.match(/\/api\/admin\/tournaments\/(\d+)\/windows\/(\d+)\/schedule$/);
      if (m)
        return {
          window: {
            id: Number(m[2]),
            stream: "league",
            round: Number(m[2]) === 202 ? 2 : 1,
            leg: null,
            week: Number(m[2]) === 202 ? 2 : 1,
            dayStart: 6,
            dayEnd: 7,
            overridden: false,
            simultaneous: false,
            lockedAt: null,
          },
          matches: [],
          violations: [],
          blocked: null,
        };
      throw new Error(`意外的 api 调用：${path}`);
    });
  });

  it("传 drill 时直接选中该段（跳转参数改为 drill.segmentId）", async () => {
    mount(
      <KickoffTab
        detail={DETAIL}
        reload={() => {}}
        drill={{ segmentId: 202, tournamentId: 13, tournamentName: "S9 | 顶级联赛" }}
      />,
    );
    await flush();
    await flush();

    const select = host!.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("202");
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/13/windows/202/schedule")).toBe(true);
    expect(text()).toContain("排期 · 单段下钻");
  });

  it("High-1：跨赛事段下钻 —— 窗口清单与下钻请求都切到段属赛事", async () => {
    mount(
      <KickoffTab
        detail={DETAIL}
        reload={() => {}}
        drill={{ segmentId: 211, tournamentId: 14, tournamentName: "S9 | 冠军杯" }}
      />,
    );
    await flush();
    await flush();

    // 窗口清单拉的是 14 号赛事（段属赛事），不再拿 13 的清单硬找 211
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/14/windows")).toBe(true);
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/13/windows")).toBe(false);
    const select = host!.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("211");
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/14/windows/211/schedule")).toBe(true);
    // 页头点明自己在编辑谁的段
    expect(text()).toContain("从赛季总览下钻：【S9 | 冠军杯】");
  });

  it("不传 drill 时保持旧行为：默认挑第一个有场次的窗口", async () => {
    mount(<KickoffTab detail={DETAIL} reload={() => {}} />);
    await flush();
    await flush();

    const select = host!.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("201");
    expect(apiCalls.some((c) => c.path === "/api/admin/tournaments/13/windows/201/schedule")).toBe(true);
  });
});

describe("旧 KickoffTab：整季体检可见 + 硬冲突放行通道（Medium-3 / Medium-2，自 season.overview.ui.test.tsx 原样迁移）", () => {
  const WINDOW_202 = {
    id: 202,
    seasonId: 1,
    stream: "league",
    round: 2,
    leg: null,
    week: 2,
    dayStart: 6,
    dayEnd: 7,
    lockedAt: null,
    matchCount: 4,
    scheduledCount: 2,
    playableCount: 4,
    hasOverride: false,
  };
  const PREVIEW_BODY = {
    proposalHash: "a".repeat(64),
    matches: [] as unknown[],
    conflicts: [] as unknown[],
    // 整季体检：141 是别的段的 override 场，与本窗口 202 无关却卡着 canCommit —— 页面必须能看见
    seasonViolations: [
      {
        matchId: 141,
        level: "hard",
        reason: "队伍 1 间隔 40.0h < 48h",
        teamId: 1,
        segmentId: 211,
        relatedMatchId: 101,
      },
    ],
    canCommit: false,
    unscheduled: [],
  };

  beforeEach(() => {
    apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
      if (path === "/api/admin/tournaments/13/windows") return { windows: [WINDOW_202] };
      if (path === "/api/admin/tournaments/13/windows/202/schedule")
        return {
          window: {
            id: 202,
            stream: "league",
            round: 2,
            leg: null,
            week: 2,
            dayStart: 6,
            dayEnd: 7,
            overridden: false,
            simultaneous: false,
            lockedAt: null,
          },
          matches: [],
          violations: [],
          blocked: null,
        };
      if (path === "/api/admin/tournaments/13/windows/202/schedule/preview") return PREVIEW_BODY;
      if (path === "/api/admin/tournaments/13/windows/202/schedule/commit")
        return { ok: true, count: 4, conflicts: [], revision: 2 };
      throw new Error(`意外的 api 调用：${path}`);
    });
  });

  it("整季体检渲染出来，canCommit=false 时不再只剩「0 条硬冲突」", async () => {
    mount(<KickoffTab detail={DETAIL} reload={() => {}} />);
    await flush();
    await flush();
    await click(button("生成提案"));

    // 生成提案的回执带上整季体检计数
    expect(text()).toContain("整季体检 1 条（硬 1）");
    // 明细列表：场次 + 关联场 + 原因
    expect(text()).toContain("整季体检（提交门槛）：1 条");
    expect(text()).toContain("#141（与 #101 相邻）");
    expect(text()).toContain("间隔 40.0h < 48h");
    // 门槛提示指向整季口径，且给出放行通道
    expect(text()).toContain("整季体检有 1 条硬冲突，提交会被拒");
    expect(text()).toContain("填放行理由");
  });

  it("canCommit=false 时提交按钮仍可点：填放行理由 → commit 带 reason", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("141 是带理由改出去的补赛，历史冲突无解");

    mount(<KickoffTab detail={DETAIL} reload={() => {}} />);
    await flush();
    await flush();
    await click(button("生成提案"));
    await click(button("提交"));

    const commitCall = apiCalls.find((c) => c.path.endsWith("/schedule/commit"));
    expect(commitCall?.body).toEqual({
      proposalHash: "a".repeat(64),
      reason: "141 是带理由改出去的补赛，历史冲突无解",
    });
    expect(prompt).toHaveBeenCalled();
    expect(text()).toContain("已带放行理由提交到赛程");
  });

  it("放行理由留空/取消都不发请求", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "prompt").mockReturnValue("");

    mount(<KickoffTab detail={DETAIL} reload={() => {}} />);
    await flush();
    await flush();
    await click(button("生成提案"));
    await click(button("提交"));

    expect(apiCalls.some((c) => c.path.endsWith("/schedule/commit"))).toBe(false);
    expect(text()).toContain("有整季硬冲突时必须填放行理由才能提交");
  });
});
