// @vitest-environment jsdom
// T9 管理端淘汰赛手动落位：分层列表 / 行信息四态 / 两步落位与轮空 / 非 2 的幂提示 / 后续轮待定文案。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import KnockoutStageView from "../src/components/KnockoutStageView";
import ScheduleTab from "../src/pages/ScheduleTab";
import type {
  EntryDTO,
  GroupDTO,
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
let refreshSpy: ReturnType<typeof vi.fn>;

const EMPTY_LABEL = "〔空〕点此落位（先点主队 → 再点客队）";

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

function labels(): string[] {
  return buttons().map((b) => (b.textContent ?? "").trim());
}

function button(label: string): HTMLButtonElement {
  const found = buttons().find((b) => (b.textContent ?? "").trim() === label);
  if (!found) throw new Error(`找不到按钮「${label}」，当前有：${labels().join(" / ")}`);
  return found;
}

function hasButton(label: string): boolean {
  return labels().includes(label);
}

function teamButton(name: string): HTMLButtonElement {
  const found = ([...(host?.querySelectorAll(".team-grid button") ?? [])] as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? "").includes(name),
  );
  if (!found) throw new Error(`候选中找不到队伍「${name}」`);
  return found;
}

function roundTitles(): string[] {
  return [...(host?.querySelectorAll(".round-title") ?? [])].map((el) => el.textContent ?? "");
}

function koRow(slot: number): HTMLTableRowElement {
  const tr = [...(host?.querySelectorAll("tr") ?? [])].find(
    (r) => (r.firstElementChild?.textContent ?? "").trim() === `场次 ${slot}`,
  );
  if (!tr) throw new Error(`找不到「场次 ${slot}」行`);
  return tr as HTMLTableRowElement;
}

function rowButtonLabels(slot: number): string[] {
  return [...koRow(slot).querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
}

function lastCall() {
  return apiCalls[apiCalls.length - 1];
}

function prime(matches: MatchDTO[], qualifiers?: Record<string, number[]>) {
  apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
    apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
    if ((opts?.method ?? "GET") === "GET") return { matches, qualifiers };
    return {};
  });
}

// ---------- fixtures ----------

const ENTRIES: EntryDTO[] = [
  { id: 11, teamId: 101, teamName: "甲队", seed: 1, groupId: 1, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
  { id: 12, teamId: 102, teamName: "乙队", seed: 2, groupId: 1, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
  { id: 13, teamId: 103, teamName: "丙队", seed: 3, groupId: 2, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
  { id: 14, teamId: 104, teamName: "丁队", seed: 4, groupId: null, playerCount: 5, pointsDeducted: 0, teamLogoUrl: null },
];

const GROUPS: GroupDTO[] = [
  { id: 1, stageId: 3, name: "A", sortOrder: 0 },
  { id: 2, stageId: 3, name: "B", sortOrder: 1 },
];

const STAGE: StageDTO = {
  id: 7,
  kind: "elim",
  sortOrder: 1,
  name: null,
  config: { legs: 1, third_place: true },
};

function detail(over: Partial<TournamentDetailDTO> = {}): TournamentDetailDTO {
  return {
    tournament: {
      id: 1,
      name: "测试杯",
      description: null,
      format: "single_elim",
      status: "running",
      createdAt: "2026-10-01T00:00:00Z",
      entryCount: ENTRIES.length,
      coverUrl: null,
    },
    stages: [STAGE],
    groups: GROUPS,
    entries: ENTRIES,
    ...over,
  };
}

function nameOf(id: number | null): string | null {
  if (id === null) return null;
  return ENTRIES.find((e) => e.id === id)?.teamName ?? null;
}

function match(over: Partial<MatchDTO> = {}): MatchDTO {
  return {
    id: 1,
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

function placed(
  round: number,
  slot: number,
  home: number | null,
  away: number | null,
  over: Partial<MatchDTO> = {},
): MatchDTO {
  return match({
    id: round * 100 + slot,
    round,
    slot,
    homeEntryId: home,
    awayEntryId: away,
    homeTeamName: nameOf(home),
    awayTeamName: nameOf(away),
    ...over,
  });
}

function shell(round: number, slot: number, over: Partial<MatchDTO> = {}): MatchDTO {
  return match({ id: round * 100 + slot, round, slot, ...over });
}

function renderKo(
  matches: MatchDTO[],
  opts: { qualifiers?: number[]; stage?: StageDTO; detail?: TournamentDetailDTO } = {},
) {
  refreshSpy = vi.fn();
  mount(
    <KnockoutStageView
      detail={opts.detail ?? detail()}
      stage={opts.stage ?? STAGE}
      matches={matches}
      qualifiers={opts.qualifiers}
      busy={false}
      onRefresh={refreshSpy}
    />,
  );
}

beforeEach(() => {
  apiCalls = [];
  apiMock.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
    apiCalls.push({ path, method: opts?.method ?? "GET", body: opts?.body });
    return {};
  });
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  unmountCurrent();
  apiMock.mockReset();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("KnockoutStageView 分层列表", () => {
  it("按第 1 轮 → 半决赛 → 决赛 → 季军赛分层渲染，两回合比分汇总", () => {
    renderKo([
      placed(1, 1, 11, 12, { id: 101, leg: 1, status: "finished", scoreHome: 2, scoreAway: 1, winnerEntryId: 11 }),
      placed(1, 1, 12, 11, { id: 102, leg: 2, status: "finished", scoreHome: 1, scoreAway: 1 }),
      placed(1, 2, 13, 14, { id: 103 }),
      placed(1, 3, 11, 13, { id: 104 }),
      placed(1, 4, 12, 14, { id: 105 }),
      shell(2, 1),
      shell(2, 2),
      shell(3, 1),
      shell(3, 2, { note: "季军赛" }),
    ]);

    expect(roundTitles()).toEqual(["1/4 决赛", "半决赛", "决赛", "季军赛"]);
    expect(text()).toContain("首回合 2:1 · 次回合 1:1 · 总比分 3:2");
    expect(text()).toContain("待定（第 1 轮·场次 1 胜者）");
    expect(text()).toContain("待定（第 1 轮·场次 2 胜者）");
    expect(text()).toContain("待定（半决赛·场次 1 胜者）");
  });

  it("空场次：两步落位进草稿不发请求，保存一次 PUT 完整快照", async () => {
    renderKo([shell(1, 1), shell(1, 2)]);

    expect(text()).toContain(EMPTY_LABEL);
    await click(button(EMPTY_LABEL));

    expect(text()).toContain("第 1 场落位");
    expect(text()).toContain("先点主队，再点客队");
    expect(teamButton("甲队").textContent).toContain("A 组");
    expect(teamButton("丙队").textContent).toContain("B 组");

    // 两队未选齐：不能确认、也不能轮空
    expect(button("确认落位").disabled).toBe(true);
    expect(button("轮空").disabled).toBe(true);

    await click(teamButton("甲队"));
    expect(text()).toContain("主队已选：再点客队，或点「轮空」");
    expect(button("确认落位").disabled).toBe(true);
    expect(button("轮空").disabled).toBe(false);

    await click(teamButton("乙队"));
    expect(teamButton("甲队").textContent).toContain("主队");
    expect(teamButton("乙队").textContent).toContain("客队");
    expect(button("确认落位").disabled).toBe(false);

    await click(button("确认落位"));
    // 落位只进草稿：不发请求，行内立即可见，出现保存条
    expect(apiCalls).toHaveLength(0);
    expect(koRow(1).textContent).toContain("甲队");
    expect(koRow(1).textContent).toContain("乙队");
    expect(text()).toContain("有未保存的更改 · 1 处");

    await click(button("保存"));
    expect(lastCall()).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/slots",
      method: "PUT",
      body: {
        slots: [
          { homeEntryId: 11, awayEntryId: 12 },
          { homeEntryId: null, awayEntryId: null },
        ],
      },
    });
    expect(refreshSpy).toHaveBeenCalled();
    expect(text()).not.toContain("有未保存的更改");
  });

  it("只选一队可「轮空」（awayEntryId 为 null），保存时随快照提交", async () => {
    renderKo([shell(1, 1)]);
    await click(button(EMPTY_LABEL));
    await click(teamButton("丙队"));
    await click(button("轮空"));
    expect(apiCalls).toHaveLength(0);
    expect(koRow(1).textContent).toContain("轮空");

    await click(button("保存"));
    expect(lastCall()).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/slots",
      method: "PUT",
      body: { slots: [{ homeEntryId: 13, awayEntryId: null }] },
    });
  });

  it("本轮已落位队在候选中置灰；改位时本场队伍可选、预选，可清除落位", async () => {
    renderKo([placed(1, 1, 11, 12), shell(1, 2)]);

    await click(button(EMPTY_LABEL));
    expect(teamButton("甲队").disabled).toBe(true);
    expect(teamButton("甲队").title).toContain("本轮已落位");
    expect(teamButton("丙队").disabled).toBe(false);
    expect(hasButton("清除落位")).toBe(false);

    await click(button("取消"));
    expect(text()).not.toContain("第 2 场落位");

    await click(button("改位"));
    expect(text()).toContain("第 1 场落位");
    expect(teamButton("甲队").disabled).toBe(false);
    expect(teamButton("甲队").textContent).toContain("主队");
    expect(teamButton("乙队").textContent).toContain("客队");
    await click(button("清除落位"));
    // 清除也只进草稿：行回到空态，保存时快照里该场为全空
    expect(apiCalls).toHaveLength(0);
    expect(rowButtonLabels(1)).toContain(EMPTY_LABEL);

    await click(button("保存"));
    expect(lastCall()).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/slots",
      method: "PUT",
      body: {
        slots: [
          { homeEntryId: null, awayEntryId: null },
          { homeEntryId: null, awayEntryId: null },
        ],
      },
    });
  });

  it("行信息：空 / 已落位未开打 / 轮空已晋级（可改位，提示会重算后续轮）", () => {
    renderKo([
      shell(1, 1),
      placed(1, 2, 11, 12),
      placed(1, 3, 13, null, { note: "轮空", winnerEntryId: 13 }),
      placed(1, 4, 14, 11),
      placed(2, 1, 13, null),
      shell(2, 2),
      shell(3, 1),
    ]);

    expect(text()).toContain(EMPTY_LABEL);
    expect(koRow(2).textContent).toContain("未开打");
    expect(rowButtonLabels(2)).toEqual(["改位", "删除"]);
    expect(koRow(3).textContent).toContain("轮空");
    // 后续轮仍待定 → 允许改位（后端会清掉过期预填并重跑晋级器），删除会牵动整段结构
    expect(koRow(3).textContent).toContain("轮空已晋级（改位会重算后续轮）");
    expect(rowButtonLabels(3)).toEqual(["改位", "删除"]);
    expect(koRow(4).textContent).toContain("未开打");
    // 尚未开打 → 结构未锁，仍可增删场次
    expect(button("〔＋新增场次〕").disabled).toBe(false);
    expect(rowButtonLabels(1)).toEqual([EMPTY_LABEL, "删除"]);
  });

  it("出现 live 场次后结构只读：禁增删，但空场次仍可展开落位", async () => {
    renderKo([
      shell(1, 1),
      placed(1, 2, 11, 12, { status: "live", scoreHome: 1, scoreAway: 0 }),
      placed(1, 3, 13, null, { note: "轮空", winnerEntryId: 13 }),
      placed(2, 1, 13, null),
      shell(2, 2),
      shell(3, 1),
    ]);

    expect(koRow(2).textContent).toContain("进行中");
    expect(button("〔＋新增场次〕").disabled).toBe(true);
    expect(text()).toContain("已有场次开打，不能增删场次");
    expect(hasButton("删除")).toBe(false);
    // 已开打的场次不可改；仍是 pending 的场次（含轮空）在后续轮未开打前可以改位
    expect(rowButtonLabels(2)).toEqual([]);
    expect(rowButtonLabels(3)).toEqual(["改位"]);

    await click(button(EMPTY_LABEL));
    expect(text()).toContain("第 1 场落位");
    await click(teamButton("丁队"));
    await click(button("轮空"));
    // 结构锁定只挡增删，落位仍走草稿；保存会被后端快照校验拦下
    expect(apiCalls).toHaveLength(0);
    expect(text()).toContain("有未保存的更改");
  });

  it("已完赛行显示徽章与晋级方，并锁定结构", () => {
    renderKo([
      placed(1, 1, 14, 11, { status: "finished", scoreHome: 3, scoreAway: 0, winnerEntryId: 14 }),
      placed(1, 2, 13, null, { note: "轮空", winnerEntryId: 13 }),
      placed(2, 1, 13, null),
      shell(2, 2),
      shell(3, 1),
    ]);

    expect(koRow(1).textContent).toContain("已完赛");
    expect(koRow(1).querySelector("b")?.textContent).toBe("丁队");
    expect(koRow(1).textContent).toContain("3 : 0");
    expect(rowButtonLabels(1)).toEqual([]);
    expect(button("〔＋新增场次〕").disabled).toBe(true);
  });

  it("首轮场次数非 2 的幂时提示，且只渲染第 1 轮", () => {
    renderKo([placed(1, 1, 11, 12), placed(1, 2, 13, 14), shell(1, 3), shell(2, 1)]);

    const titles = roundTitles();
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("第 1 轮");
    expect(text()).toContain("首轮场次数需为 2 的幂（当前 3 场）");
    expect(button("〔＋新增场次〕").disabled).toBe(false);
    expect(rowButtonLabels(3)).toEqual([EMPTY_LABEL, "删除"]);
  });

  it("空阶段新增场次进草稿；删除场次进草稿并前移序号，保存一次提交", async () => {
    renderKo([]);
    expect(text()).toContain("首轮还没有场次");
    expect(button("〔＋新增场次〕").disabled).toBe(false);
    await click(button("〔＋新增场次〕"));
    expect(apiCalls).toHaveLength(0);
    expect(rowButtonLabels(1)).toContain(EMPTY_LABEL);
    expect(text()).toContain("有未保存的更改 · 1 处");
    await click(button("保存"));
    expect(lastCall()).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/slots",
      method: "PUT",
      body: { slots: [{ homeEntryId: null, awayEntryId: null }] },
    });
    expect(refreshSpy).toHaveBeenCalled();

    renderKo([shell(1, 1), shell(1, 2)]);
    apiCalls = [];
    await click(button("删除"));
    expect(apiCalls).toHaveLength(0);
    // 删第 1 场后原第 2 场前移为第 1 场（草稿序号重排）
    expect(rowButtonLabels(1)).toContain(EMPTY_LABEL);
    expect(text()).toContain("有未保存的更改 · 1 处");
    await click(button("保存"));
    expect(lastCall()).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/slots",
      method: "PUT",
      body: { slots: [{ homeEntryId: null, awayEntryId: null }] },
    });
  });

  it("首轮满 16 场时新增按钮禁用并提示上限", () => {
    const many: MatchDTO[] = [];
    for (let slot = 1; slot <= 16; slot += 1) many.push(shell(1, slot));
    for (let slot = 1; slot <= 8; slot += 1) many.push(shell(2, slot));
    renderKo(many);
    expect(roundTitles()[0]).toBe("1/16 决赛");
    expect(button("〔＋新增场次〕").disabled).toBe(true);
    expect(text()).toContain("已达上限（16 场）");
  });

  it("qualifiers 队伍置顶并标「出线」", async () => {
    renderKo([shell(1, 1)], { qualifiers: [13] });
    await click(button(EMPTY_LABEL));
    const grid = [...(host?.querySelectorAll(".team-grid button") ?? [])];
    expect(grid[0]?.textContent).toContain("丙队");
    expect(grid[0]?.querySelector(".badge")?.textContent).toBe("出线");
    expect(grid[1]?.textContent).toContain("甲队");
  });
});

describe("淘汰赛草稿与一键铺位", () => {
  it("一键铺位：按出线队数铺最小满编 2 幂场数，保存一次提交空快照", async () => {
    renderKo([], { qualifiers: [11, 12, 13] });
    expect(button("按出线队数铺 2 场（出线 3 队）")).toBeTruthy();
    expect(text()).toContain("出线 3 队满编 4 队，多出席位可设轮空或删除场次。");

    await click(button("按出线队数铺 2 场（出线 3 队）"));
    expect(apiCalls).toHaveLength(0);
    expect(rowButtonLabels(1)).toContain(EMPTY_LABEL);
    expect(rowButtonLabels(2)).toContain(EMPTY_LABEL);
    expect(text()).toContain("有未保存的更改 · 2 处");

    await click(button("保存"));
    expect(lastCall()).toMatchObject({
      path: "/api/admin/tournaments/1/stages/7/slots",
      method: "PUT",
      body: {
        slots: [
          { homeEntryId: null, awayEntryId: null },
          { homeEntryId: null, awayEntryId: null },
        ],
      },
    });
  });

  it("出线名单未生成时铺场按钮禁用并说明", () => {
    renderKo([]);
    const btn = buttons().find((b) => (b.textContent ?? "").includes("按出线队数铺"));
    expect(btn?.disabled).toBe(true);
    expect(btn?.title).toContain("出线名单未生成");
    expect(text()).toContain("出线名单未生成（小组赛未完赛或未配置取人规则）");
  });

  it("刷新后从 sessionStorage 恢复草稿；放弃恢复原状", async () => {
    renderKo([shell(1, 1), shell(1, 2)]);
    await click(button(EMPTY_LABEL));
    await click(teamButton("甲队"));
    await click(teamButton("乙队"));
    await click(button("确认落位"));
    expect(text()).toContain("有未保存的更改 · 1 处");

    // 模拟刷新：重新挂载同 props
    renderKo([shell(1, 1), shell(1, 2)]);
    expect(koRow(1).textContent).toContain("甲队");
    expect(koRow(1).textContent).toContain("乙队");
    expect(text()).toContain("有未保存的更改 · 1 处");

    await click(button("放弃"));
    expect(koRow(1).textContent).toContain(EMPTY_LABEL);
    expect(text()).not.toContain("有未保存的更改");
    expect(window.sessionStorage.getItem("whl.ko.draft.1.7")).toBe(null);
  });

  it("保存失败：错误显示在保存条，草稿保留", async () => {
    renderKo([shell(1, 1)]);
    await click(button(EMPTY_LABEL));
    await click(teamButton("甲队"));
    await click(button("轮空"));
    apiMock.mockImplementationOnce(async () => {
      throw new Error("该场次已开打，不能调整落位");
    });
    await click(button("保存"));
    expect(text()).toContain("该场次已开打，不能调整落位");
    expect(text()).toContain("有未保存的更改");
  });
});

describe("KnockoutStageView 后续轮与季军赛", () => {
  it("后续轮未定席位显示来源胜者，回填后直接显示队名", () => {
    renderKo([
      placed(1, 1, 11, 12),
      placed(1, 2, 13, 14),
      shell(2, 1),
      shell(2, 2, { note: "季军赛" }),
    ]);

    expect(roundTitles()).toEqual(["半决赛", "决赛", "季军赛"]);
    expect(text()).toContain("待定（第 1 轮·场次 1 胜者）");
    expect(text()).toContain("待定（第 1 轮·场次 2 胜者）");
    expect(text()).toContain("待定（半决赛·场次 1 负者）");
    expect(text()).toContain("待定（半决赛·场次 2 负者）");

    renderKo([
      placed(1, 1, 11, 12),
      placed(1, 2, 13, 14),
      placed(2, 1, 11, 13),
      shell(2, 2, { note: "季军赛" }),
    ]);
    expect(text()).toContain("甲队");
    expect(text()).not.toContain("待定（第 1 轮·场次 1 胜者）");
  });
});

describe("ScheduleTab 淘汰阶段接入", () => {
  it("移除自动生成按钮、配置锁定，并把 qualifiers 传给落位面板", async () => {
    prime([shell(1, 1)], { "7": [13] });
    mount(<ScheduleTab detail={detail()} reload={vi.fn()} />);
    await flush();

    expect(apiCalls[0]).toMatchObject({ path: "/api/admin/tournaments/1/matches", method: "GET" });
    expect(labels().some((l) => l.includes("自动生成"))).toBe(false);
    expect(labels()).toContain("〔＋新增场次〕");
    expect(text()).toContain("配置已锁定（要改先清除赛程）");
    const selects = [...(host?.querySelectorAll("select") ?? [])] as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((s) => s.disabled)).toBe(true);

    await click(button(EMPTY_LABEL));
    const grid = [...(host?.querySelectorAll(".team-grid button") ?? [])];
    expect(grid[0]?.textContent).toContain("丙队");
    expect(grid[0]?.querySelector(".badge")?.textContent).toBe("出线");
  });
});
