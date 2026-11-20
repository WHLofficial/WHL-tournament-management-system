// @vitest-environment jsdom
// S4 赛季排期总览页（ScheduleSeasonTab）：阶段矩阵（行=赛事、列=段、状态灯+数量）、
// 三套方案并排对比、冲突建议一键应用、快照历史一键恢复；旧 KickoffTab 收 segmentId 下钻。
// 沿用 tests/schedule.manual.ui.test.tsx 的手搓根节点范式（仓库未装 @testing-library）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import ScheduleSeasonTab from "../src/pages/ScheduleSeasonTab";
import KickoffTab from "../src/pages/KickoffTab";
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

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let apiCalls: { path: string; method: string; body?: unknown }[] = [];
const drilldown = vi.fn();

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

function mountSeasonTab() {
  mount(<ScheduleSeasonTab detail={DETAIL} reload={() => {}} onDrilldown={drilldown} />);
}

beforeEach(() => {
  apiCalls = [];
  apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
    apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
    // High-1：13 号赛事的窗口清单只有它自己的段；211/214 属于 14 号赛事，
    // 旧夹具把它们塞进 13/windows，把「跨赛事下钻 404」的断链盖住了。
    if (path === "/api/admin/tournaments/13/windows")
      return {
        windows: [
          { id: 201, seasonId: 1, matchCount: 4 },
          { id: 202, seasonId: 1, matchCount: 4 },
        ],
      };
    if (path === "/api/admin/seasons/1/schedule") return overviewFixture();
    if (path === "/api/admin/seasons/1/schedule/preview") return previewFixture();
    if (path === "/api/admin/seasons/1/schedule/commit") return commitFixture();
    if (path === "/api/admin/seasons/1/schedule/restore/1") return restoreFixture();
    throw new Error(`意外的 api 调用：${path}`);
  });
});

afterEach(() => {
  unmountCurrent();
  vi.restoreAllMocks();
});

describe("S4 赛季总览：阶段矩阵 + 状态灯 + 数量", () => {
  it("行 = 赛事、列 = 排期段；每格状态灯（绿/黄/红/灰）+ 已排/可排数量", async () => {
    mountSeasonTab();
    await flush();
    await flush();

    const rows = [...host!.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector(".seg-cell"));
    expect(rows).toHaveLength(2); // 两个赛事各一行（快照表另算）
    expect(rows[0]!.textContent).toContain("S9 | 顶级联赛");
    expect(rows[1]!.textContent).toContain("S9 | 冠军杯");

    const cells = [...host!.querySelectorAll<HTMLElement>(".seg-cell")];
    expect(cells).toHaveLength(4);
    const cell201 = cells.find((c) => c.textContent?.includes("第1周"))!;
    const cell202 = cells.find((c) => c.textContent?.includes("第2周 · 第2轮"))!;
    const cell211 = cells.find((c) => c.textContent?.includes("第2周 · 第1轮"))!;
    const cell214 = cells.find((c) => c.textContent?.includes("第8周"))!;

    expect(cell201.querySelector(".season-dot-green")).toBeTruthy(); // 排满且无冲突
    expect(cell201.textContent).toContain("4/4");
    expect(cell202.querySelector(".season-dot-yellow")).toBeTruthy(); // 有待排
    expect(cell202.textContent).toContain("2/4");
    expect(cell211.querySelector(".season-dot-red")).toBeTruthy(); // 有硬冲突
    expect(cell214.querySelector(".season-dot-gray")).toBeTruthy(); // 已公布锁定
    expect(cell214.textContent).toContain("🔒");

    // 顶部汇总：硬/软/提示数量
    expect(text()).toContain("硬冲突 1");
    expect(text()).toContain("软冲突 1");
  });

  it("点格子走 onDrilldown(segment)，带段属赛事（跨赛事段必须带 tid）", async () => {
    mountSeasonTab();
    await flush();
    await flush();

    const cell202 = [...host!.querySelectorAll<HTMLElement>(".seg-cell")].find((c) =>
      c.textContent?.includes("第2周 · 第2轮"),
    )!;
    await click(cell202);
    expect(drilldown).toHaveBeenCalledWith(
      expect.objectContaining({ id: 202, tournamentId: 13, tournamentName: "S9 | 顶级联赛" }),
    );

    // High-1 回归：点别的赛事（冠军杯）的段，tid 也要跟过去
    const cell211 = [...host!.querySelectorAll<HTMLElement>(".seg-cell")].find((c) =>
      c.textContent?.includes("第2周 · 第1轮"),
    )!;
    await click(cell211);
    expect(drilldown).toHaveBeenCalledWith(
      expect.objectContaining({ id: 211, tournamentId: 14, tournamentName: "S9 | 冠军杯" }),
    );
  });

  it("冲突明细列出场次/球队/间隔；hard/soft 带应用建议按钮，report 不带", async () => {
    mountSeasonTab();
    await flush();
    await flush();

    const viol = host!.querySelector(".season-viol")!;
    const items = [...viol.querySelectorAll("li")];
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("#141 队伍 1 间隔 40.0h < 48h");
    expect(items[1].textContent).toContain("队伍 2 间隔 60.0h");
    expect(items[2].textContent).toContain("队伍 3 间隔 68.0h");

    const applyButtons = items.filter((li) => li.querySelector("button"));
    expect(applyButtons).toHaveLength(2); // report 没有按钮
  });
});

describe("S4 赛季总览：三套方案并排 + 一键应用", () => {
  it("生成整季方案 → 三栏并排、指标摘要齐全、硬冲突方案禁用应用", async () => {
    mountSeasonTab();
    await flush();
    await flush();

    await click(button("生成整季方案（3 套）"));
    const cols = [...host!.querySelectorAll(".season-col")];
    expect(cols).toHaveLength(3);
    const titles = cols.map((c) => c.querySelector("h4")?.textContent ?? "");
    expect(titles[0]).toContain("方案 A");
    expect(titles[1]).toContain("方案 B");
    expect(titles[2]).toContain("方案 C");
    for (const col of cols) {
      expect(col.textContent).toContain("硬冲突");
      expect(col.textContent).toContain("最小间隔");
      expect(col.textContent).toContain("晚场占比");
      expect(col.textContent).toContain("最大连续负荷");
    }
    // 方案 C 有硬冲突：应用按钮禁用；A/B 可用
    const applyC = cols[2].querySelector<HTMLButtonElement>("button.btn")!;
    expect(applyC.disabled).toBe(true);
    expect(cols[0].querySelector<HTMLButtonElement>("button.btn")!.disabled).toBe(false);

    const previewCall = apiCalls.find((c) => c.path.endsWith("/preview"));
    expect(previewCall?.method).toBe("POST");
    expect(previewCall?.body).toEqual({});
  });

  it("「应用此方案」提交候选 key+hash 并刷新总览", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountSeasonTab();
    await flush();
    await flush();
    await click(button("生成整季方案（3 套）"));

    const cols = [...host!.querySelectorAll(".season-col")];
    await click(cols[0].querySelector("button.btn")!);

    const commitCall = apiCalls.find((c) => c.path.endsWith("/commit"));
    expect(commitCall?.body).toEqual({ key: "A", hash: HASH_A });
    expect(text()).toContain("已应用方案 A");
    expect(text()).toContain("版本 r3");
    // 提交后重新拉总览
    expect(apiCalls.filter((c) => c.path === "/api/admin/seasons/1/schedule").length).toBeGreaterThanOrEqual(2);
  });

  it("冲突「应用建议」：只对该段求解并提交最优候选", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountSeasonTab();
    await flush();
    await flush();

    const applyBtn = [...host!.querySelectorAll<HTMLButtonElement>(".season-viol button")][0];
    await click(applyBtn);

    const previewCall = apiCalls.find((c) => c.path.endsWith("/preview") && (c.body as { segmentIds?: number[] })?.segmentIds);
    expect(previewCall?.body).toEqual({ segmentIds: [211] });
    const commitCall = apiCalls.find((c) => c.path.endsWith("/commit"));
    // 三套候选里 A 最优（硬 0 软 1）
    expect(commitCall?.body).toEqual({ key: "A", hash: HASH_A, segmentIds: [211] });
    expect(text()).toContain("已应用建议（方案 A）");
  });
});

describe("S4 赛季总览：快照历史 + 一键恢复", () => {
  it("revision 列表（版本/状态/场次/体检/备注）+ 恢复按钮回滚", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountSeasonTab();
    await flush();
    await flush();

    // 快照表在矩阵之后：两行版本（r2 已公布 / r1 已提交）
    const snapshotRows = [...host!.querySelectorAll("tbody tr")].filter((tr) =>
      tr.textContent?.match(/^r\d/),
    );
    expect(snapshotRows).toHaveLength(2);
    expect(snapshotRows[0].textContent).toContain("已公布");
    expect(snapshotRows[1].textContent).toContain("已提交");
    expect(snapshotRows[1].textContent).toContain("整季提交");

    const restoreBtn = [...snapshotRows[1].querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("恢复"),
    );
    expect(restoreBtn).toBeTruthy();
    await click(restoreBtn!);
    const restoreCall = apiCalls.find((c) => c.path.endsWith("/restore/1"));
    expect(restoreCall?.method).toBe("POST");
    expect(text()).toContain("已回滚到 r1");
    expect(text()).toContain("写回 2 场");
    expect(text()).toContain("跳过 1 场");
  });
});

describe("S4 旧 KickoffTab：单段下钻入口", () => {
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

describe("S4 旧 KickoffTab：整季体检可见 + 硬冲突放行通道（Medium-3 / Medium-2）", () => {
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
