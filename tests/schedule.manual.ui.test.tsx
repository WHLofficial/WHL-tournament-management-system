// @vitest-environment jsdom
// 小组/循环排赛草稿态：点选入草稿不发请求 / 行删除待删除+撤销 / 改轮次不清空 / sessionStorage 恢复与放弃 / 保存一次 PUT batch。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import ScheduleTab from "../src/pages/ScheduleTab";
import type {
  EntryDTO,
  MatchDTO,
  StageDTO,
  TournamentDetailDTO,
} from "../shared/types";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: apiMock };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let apiCalls: { path: string; method: string; body?: unknown }[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let reload: ReturnType<typeof vi.fn>;

function unmountCurrent() {
  const r = root;
  if (r) {
    act(() => {
      r.unmount();
    });
  }
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
  if (!found) throw new Error(`找不到按钮「${label}」，当前有：${buttons().map((b) => (b.textContent ?? "").trim()).join(" / ")}`);
  return found;
}

function teamButton(name: string): HTMLButtonElement {
  const found = ([...(host?.querySelectorAll(".team-grid button") ?? [])] as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? "").includes(name),
  );
  if (!found) throw new Error(`候选中找不到队伍「${name}」`);
  return found;
}

function lastCall() {
  return apiCalls[apiCalls.length - 1];
}

function prime(matches: MatchDTO[]) {
  apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
    apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
    if ((opts?.method ?? "GET") === "GET") return { matches, qualifiers: {} };
    return {};
  });
}

// ---------- fixtures ----------

const ENTRIES: EntryDTO[] = [
  { id: 11, teamId: 101, teamName: "甲队", seed: 1, groupId: null, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
  { id: 12, teamId: 102, teamName: "乙队", seed: 2, groupId: null, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
  { id: 13, teamId: 103, teamName: "丙队", seed: 3, groupId: null, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
  { id: 14, teamId: 104, teamName: "丁队", seed: 4, groupId: null, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
];

const STAGE: StageDTO = {
  id: 7,
  kind: "round_robin",
  sortOrder: 1,
  name: null,
  config: { loops: 1 },
};

function match(over: Partial<MatchDTO>): MatchDTO {
  return {
    id: 102,
    stageId: 7,
    round: 1,
    slot: 1,
    leg: null,
    homeEntryId: null,
    awayEntryId: null,
    homeTeamName: null,
    awayTeamName: null,
    scoreHome: null,
    scoreAway: null,
    penHome: null,
    penAway: null,
    status: "pending",
    winnerEntryId: null,
    note: null,
    ...over,
  };
}

const MATCHES: MatchDTO[] = [
  match({ homeEntryId: 11, awayEntryId: 12, homeTeamName: "甲队", awayTeamName: "乙队" }),
];

function detail(): TournamentDetailDTO {
  return {
    tournament: {
      id: 1,
      name: "测试杯",
      description: null,
      format: "league",
      status: "running",
      createdAt: "2026-10-01T00:00:00Z",
      entryCount: ENTRIES.length,
      coverUrl: null,
    },
    stages: [STAGE],
    groups: [],
    entries: ENTRIES,
  };
}

function renderTab(matches: MatchDTO[]) {
  prime(matches);
  reload = vi.fn();
  mount(<ScheduleTab detail={detail()} reload={reload} />);
  return flush();
}

// ---------- tests ----------

beforeEach(() => {
  apiCalls = [];
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  unmountCurrent();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ScheduleTab 小组/循环排赛草稿态", () => {
  it("点两队入草稿不发请求，保存一次 PUT batch；同轮重复加入被拦", async () => {
    await renderTab(MATCHES);

    await click(teamButton("丙队"));
    await click(teamButton("丁队"));
    expect(apiCalls).toHaveLength(1); // 只有初始 GET /matches
    expect(text()).toContain("新增 1 场 · 删除 0 场");
    expect(text()).toContain("第 1 轮：丙队 vs 丁队");

    // 同一场草稿不能重复排：已在本批的队不能作主队
    await click(teamButton("丙队"));
    expect(text()).toContain("丙队 已在本批中，不能作主队");
    expect(apiCalls).toHaveLength(1);

    await click(button("保存"));
    const put1 = apiCalls.find((c) => c.method === "PUT");
    expect(put1).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/matches/batch",
      method: "PUT",
      body: { adds: [{ round: 1, homeEntryId: 13, awayEntryId: 14 }], deleteIds: [] },
    });
    expect(reload).toHaveBeenCalled();
    expect(text()).not.toContain("新增 1 场");
    expect(window.sessionStorage.getItem("whl.sched.draft.1.7")).toBe(null);
  });

  it("行删除进草稿标「待删除」可撤销，保存一次提交 deleteIds", async () => {
    await renderTab(MATCHES);

    await click(button("删除"));
    expect(apiCalls).toHaveLength(1); // 只有初始 GET
    expect(text()).toContain("待删除");
    expect(hasButtonName("撤销")).toBe(true);

    await click(button("撤销"));
    expect(text()).not.toContain("待删除");
    expect(text()).not.toContain("新增 0 场");

    await click(button("删除"));
    await click(button("保存"));
    const put2 = apiCalls.find((c) => c.method === "PUT");
    expect(put2).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/matches/batch",
      method: "PUT",
      body: { adds: [], deleteIds: [102] },
    });
    expect(window.sessionStorage.getItem("whl.sched.draft.1.7")).toBe(null);
  });

  it("改轮次不清空已选：跨轮复用同队入草稿，保存按各自轮次提交", async () => {
    await renderTab(MATCHES);

    await click(teamButton("丙队"));
    await click(teamButton("丁队")); // 第 1 轮（默认当前轮）

    const input = host?.querySelector('.manual-pick input[type="number"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    // 已选的第 1 轮场次仍在；丙可跨轮复用（同轮占用才拦截）
    expect(text()).toContain("第 1 轮：丙队 vs 丁队");
    await click(teamButton("丙队"));
    await click(teamButton("甲队")); // 第 2 轮
    expect(text()).toContain("新增 2 场 · 删除 0 场");
    expect(text()).toContain("第 2 轮：丙队 vs 甲队");

    await click(button("保存"));
    const put3 = apiCalls.find((c) => c.method === "PUT");
    expect(put3).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/matches/batch",
      method: "PUT",
      body: {
        adds: [
          { round: 1, homeEntryId: 13, awayEntryId: 14 },
          { round: 2, homeEntryId: 13, awayEntryId: 11 },
        ],
        deleteIds: [],
      },
    });
  });

  it("刷新后从 sessionStorage 恢复草稿；放弃恢复原状", async () => {
    await renderTab(MATCHES);
    await click(teamButton("丙队"));
    await click(teamButton("丁队"));
    expect(text()).toContain("新增 1 场 · 删除 0 场");

    // 模拟刷新：重新挂载同 props
    await renderTab(MATCHES);
    expect(text()).toContain("新增 1 场 · 删除 0 场");
    expect(text()).toContain("第 1 轮：丙队 vs 丁队");

    await click(button("放弃"));
    expect(text()).not.toContain("新增 1 场");
    expect(window.sessionStorage.getItem("whl.sched.draft.1.7")).toBe(null);
  });

  it("保存失败：错误显示在保存条，草稿保留", async () => {
    await renderTab(MATCHES);
    await click(teamButton("丙队"));
    await click(teamButton("丁队"));
    apiMock.mockImplementationOnce(async () => {
      throw new Error("第 1 场：两队在本阶段已交手过");
    });
    await click(button("保存"));
    expect(text()).toContain("第 1 场：两队在本阶段已交手过");
    expect(text()).toContain("新增 1 场 · 删除 0 场");
  });

  it("本轮已有比赛或已在本批的队不能作主队；已在本批的队作客队置灰", async () => {
    await renderTab(MATCHES);

    // 库内甲乙已在第 1 轮：甲不能作主队
    await click(teamButton("甲队"));
    expect(text()).toContain("甲队 本轮已有比赛，不能作主队");

    // 客队侧：清掉库内场次腾出第三支自由队作主队，已在本批的队置灰
    window.sessionStorage.clear();
    await renderTab([]);
    await click(teamButton("丙队"));
    await click(teamButton("丁队"));
    await click(teamButton("甲队"));
    expect(teamButton("丙队").disabled).toBe(true);
    expect(teamButton("丙队").title).toBe("本批已选");
  });

  it("待删除场次不再占用，草稿算入交手计数", async () => {
    await renderTab(MATCHES);
    // 库内甲乙已在第 1 轮：甲不能作主队（提前拦截）
    await click(teamButton("甲队"));
    expect(text()).toContain("甲队 本轮已有比赛，不能作主队");

    // 甲乙那场进草稿待删除后即不再占用，两人可重排
    await click(button("删除"));
    await click(teamButton("甲队"));
    expect(teamButton("乙队").disabled).toBe(false);
    await click(teamButton("乙队"));
    expect(text()).toContain("新增 1 场 · 删除 1 场");

    await click(button("保存"));
    const put6 = apiCalls.find((c) => c.method === "PUT");
    expect(put6).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/matches/batch",
      method: "PUT",
      body: {
        adds: [{ round: 1, homeEntryId: 11, awayEntryId: 12 }],
        deleteIds: [102],
      },
    });
  });
});

function hasButtonName(label: string): boolean {
  return buttons().some((b) => (b.textContent ?? "").trim() === label);
}
