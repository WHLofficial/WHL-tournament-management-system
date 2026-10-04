// @vitest-environment jsdom
// T10 公开赛程页：淘汰赛两回合分块、空席位占位、零场次阶段提示。
// 仓库未装 @testing-library，沿用 tests/datetime.test.tsx 的 react-dom/client + act 手搓根节点范式。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import PublicTournament, {
  RoundMatches,
  emptyElimStages,
  groupElimRound,
  matchupWinnerId,
  seatLabel,
} from "../src/pages/PublicTournament";
import type { MatchDTO, StageDTO, StageRoundsDTO, TournamentDetailDTO } from "../shared/types";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: apiMock };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  host?.remove();
  host = null;
  apiMock.mockReset();
});

function match(over: Partial<MatchDTO> = {}): MatchDTO {
  return {
    id: 1,
    stageId: 9,
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

/** 取当前挂载节点下的「区块标题 + 区块内行」序列（RoundMatches 直接渲染成片段） */
function blocks(): { title: string; rows: HTMLElement[] }[] {
  const out: { title: string; rows: HTMLElement[] }[] = [];
  for (const el of [...(host?.children ?? [])] as HTMLElement[]) {
    if (el.classList.contains("round-title")) out.push({ title: el.textContent ?? "", rows: [] });
    else if (el.classList.contains("match-row") && out.length > 0) out[out.length - 1].rows.push(el);
  }
  return out;
}

function renderRound(stageKind: StageRoundsDTO["kind"], rows: MatchDTO[]) {
  mount(
    <MemoryRouter>
      <RoundMatches tid={1} stageKind={stageKind} rows={rows} />
    </MemoryRouter>,
  );
}

function teamTexts(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".mr-team")].map((t) => t.textContent ?? "");
}

describe("groupElimRound（回合分块）", () => {
  it("两回合制轮次按 slot 配对，leg1/leg2 各归其位且按 slot 排序", () => {
    const rows = [
      match({ id: 4, slot: 2, leg: 2 }),
      match({ id: 1, slot: 1, leg: 1 }),
      match({ id: 3, slot: 2, leg: 1 }),
      match({ id: 2, slot: 1, leg: 2 }),
    ];
    const l = groupElimRound(rows);
    expect(l.twoLeg).toBe(true);
    expect(l.pairs.map((p) => [p.slot, p.leg1?.id ?? null, p.leg2?.id ?? null])).toEqual([
      [1, 1, 2],
      [2, 3, 4],
    ]);
  });

  it("轮空单行（leg=null）只落 leg1 侧，不影响其他 slot 配对", () => {
    const rows = [
      match({ id: 9, slot: 2, leg: 2 }),
      match({ id: 8, slot: 2, leg: 1 }),
      match({ id: 7, slot: 1, note: "轮空", homeEntryId: 100, winnerEntryId: 100 }),
    ];
    const l = groupElimRound(rows);
    expect(l.twoLeg).toBe(true);
    expect(l.pairs.map((p) => [p.slot, p.leg1?.id ?? null, p.leg2?.id ?? null])).toEqual([
      [1, 7, null],
      [2, 8, 9],
    ]);
  });

  it("整轮 leg 全为 null（单场轮次）→ 不分块", () => {
    const l = groupElimRound([match({ id: 1 }), match({ id: 2, slot: 2 })]);
    expect(l.twoLeg).toBe(false);
    expect(l.pairs).toEqual([]);
  });
});

describe("matchupWinnerId（两回合晋级方）", () => {
  const leg1 = match({
    id: 1,
    slot: 1,
    leg: 1,
    homeEntryId: 1,
    awayEntryId: 2,
    homeTeamName: "北京",
    awayTeamName: "上海",
    scoreHome: 3,
    scoreAway: 1,
    status: "finished",
  });

  it("总比分高者晋级（不依赖 leg2 行的 winnerEntryId）", () => {
    const leg2 = match({
      id: 2,
      slot: 1,
      leg: 2,
      homeEntryId: 2,
      awayEntryId: 1,
      homeTeamName: "上海",
      awayTeamName: "北京",
      scoreHome: 0,
      scoreAway: 2,
      status: "finished",
      winnerEntryId: 1,
    });
    expect(matchupWinnerId(leg1, leg2)).toBe(1);
  });

  it("总比分打平看点球（点球在次回合）", () => {
    const l1 = match({ ...leg1, scoreHome: 2, scoreAway: 2 });
    const l2 = match({
      id: 2,
      slot: 1,
      leg: 2,
      homeEntryId: 2,
      awayEntryId: 1,
      scoreHome: 1,
      scoreAway: 1,
      penHome: 4,
      penAway: 3,
      status: "finished",
    });
    expect(matchupWinnerId(l1, l2)).toBe(2);
  });

  it("次回合未报分 / 单行轮空 → 按可用信息取或 null", () => {
    const pending = match({ id: 2, slot: 1, leg: 2, homeEntryId: 2, awayEntryId: 1 });
    expect(matchupWinnerId(leg1, pending)).toBeNull();
    expect(matchupWinnerId(null, match({ id: 3, winnerEntryId: 7 }))).toBe(7);
  });
});

describe("seatLabel（空席位占位）", () => {
  it("队名优先，其次占位，缺省回退「待定」", () => {
    expect(seatLabel("北京", "1/2")).toBe("北京");
    expect(seatLabel(null, "1/2")).toBe("1/2");
    expect(seatLabel(null, "  ")).toBe("待定");
    expect(seatLabel(null, null)).toBe("待定");
    expect(seatLabel(null, undefined)).toBe("待定");
  });
});

describe("emptyElimStages（零场次淘汰阶段）", () => {
  const elim = (id: number, name = ""): StageDTO => ({
    id,
    kind: "elim",
    sortOrder: id,
    name,
    config: {},
  });
  const meta = (stageId: number): StageRoundsDTO => ({
    stageId,
    name: "",
    kind: "elim",
    sortOrder: stageId,
    rounds: [],
  });

  it("只在 rounds 元信息里缺席的 elim 阶段算零场次", () => {
    const stages = [elim(1, "复赛"), elim(2), { ...elim(3), kind: "group" as const }];
    const empty = emptyElimStages(stages, [meta(1)]);
    expect(empty.map((s) => s.id)).toEqual([2]);
  });
});

describe("RoundMatches（赛程行渲染）", () => {
  it("两回合轮次分「首回合」「次回合」两块：首回合只有本回合比分，次回合带总比分且晋级方高亮", () => {
    const leg1 = match({
      id: 11,
      slot: 1,
      leg: 1,
      homeEntryId: 1,
      awayEntryId: 2,
      homeTeamName: "北京",
      awayTeamName: "上海",
      scoreHome: 3,
      scoreAway: 1,
      status: "finished",
      winnerEntryId: 1,
    });
    const leg2 = match({
      id: 12,
      slot: 1,
      leg: 2,
      homeEntryId: 2,
      awayEntryId: 1,
      homeTeamName: "上海",
      awayTeamName: "北京",
      scoreHome: 0,
      scoreAway: 2,
      status: "finished",
      winnerEntryId: 1,
    });
    renderRound("elim", [leg2, leg1]);

    const bs = blocks();
    expect(bs.map((b) => b.title)).toEqual(["首回合", "次回合"]);
    expect(bs[0].rows).toHaveLength(1);
    expect(bs[1].rows).toHaveLength(1);

    const first = bs[0].rows[0];
    expect(first.textContent).toContain("3");
    expect(first.textContent).toContain("1");
    expect(first.textContent).not.toContain("总比分");
    expect(first.querySelector(".mr-win")).toBeNull();

    const second = bs[1].rows[0];
    expect(second.textContent).toContain("总比分");
    expect(second.textContent).toContain("1:5");
    // 队名旁有 TeamLogo 首字回退，textContent 会是「北北京」
    const winners = [...second.querySelectorAll(".mr-team.mr-win")];
    expect(winners).toHaveLength(1);
    expect(winners[0].textContent).toContain("北京");
  });

  it("轮空单行（无 leg2）保留本行 winner 高亮", () => {
    renderRound("elim", [
      match({
        id: 21,
        slot: 1,
        note: "轮空",
        homeEntryId: 5,
        awayEntryId: null,
        homeTeamName: "北京",
        status: "finished",
        winnerEntryId: 5,
      }),
      match({ id: 22, slot: 2, leg: 1, homeEntryId: 6, awayEntryId: 7 }),
      match({ id: 23, slot: 2, leg: 2, homeEntryId: 7, awayEntryId: 6 }),
    ]);
    const bs = blocks();
    expect(bs.map((b) => b.title)).toEqual(["首回合", "次回合"]);
    expect(bs[0].rows[0].querySelector(".mr-win")?.textContent).toContain("北京");
    expect(bs[0].rows[1].querySelector(".mr-win")).toBeNull();
  });

  it("单场轮次（leg 全为 null）不分块，整轮一行一场", () => {
    renderRound("elim", [
      match({
        id: 31,
        slot: 1,
        homeEntryId: 1,
        awayEntryId: 2,
        homeTeamName: "甲",
        awayTeamName: "乙",
        scoreHome: 2,
        scoreAway: 0,
        status: "finished",
        winnerEntryId: 1,
      }),
      match({ id: 32, slot: 2, homeEntryId: 3, awayEntryId: 4, homeTeamName: "丙", awayTeamName: "丁" }),
    ]);
    expect(host!.querySelectorAll(".round-title")).toHaveLength(0);
    expect(host!.querySelectorAll(".match-row")).toHaveLength(2);
    expect(host!.querySelector(".mr-win")?.textContent).toContain("甲");
  });

  it("非淘汰阶段即便有 leg 也不分块", () => {
    renderRound("group", [match({ id: 41, leg: 1 }), match({ id: 42, leg: 2 })]);
    expect(host!.querySelectorAll(".round-title")).toHaveLength(0);
    expect(host!.querySelectorAll(".match-row")).toHaveLength(2);
  });

  it("空席位显示候选占位「1/2 vs 3/4」，次回合沿用对调后的占位", () => {
    renderRound("elim", [
      match({ id: 51, slot: 1, leg: 1, homePlaceholder: "1/2", awayPlaceholder: "3/4" }),
      match({ id: 52, slot: 1, leg: 2, homePlaceholder: "3/4", awayPlaceholder: "1/2" }),
    ]);
    const bs = blocks();
    expect(teamTexts(bs[0].rows[0])).toEqual(["1/2", "3/4"]);
    expect(teamTexts(bs[1].rows[0])).toEqual(["3/4", "1/2"]);
  });

  it("占位缺省/空白回退「待定」", () => {
    renderRound("elim", [
      match({ id: 61, slot: 1, homePlaceholder: undefined, awayPlaceholder: "" }),
      match({ id: 62, slot: 2, homePlaceholder: null, awayPlaceholder: "   " }),
    ]);
    expect(teamTexts(host!.querySelectorAll(".match-row")[0] as HTMLElement)).toEqual(["待定", "待定"]);
    expect(teamTexts(host!.querySelectorAll(".match-row")[1] as HTMLElement)).toEqual(["待定", "待定"]);
  });
});

describe("公开赛程页整页", () => {
  const detail: TournamentDetailDTO = {
    tournament: {
      id: 1,
      name: "测试杯",
      description: null,
      format: "group_knockout",
      status: "running",
      createdAt: "2026-10-01T00:00:00.000Z",
      entryCount: 8,
      coverUrl: null,
    },
    stages: [
      { id: 9, kind: "elim", sortOrder: 2, name: "复赛", config: { legs: 2 } },
      { id: 10, kind: "group", sortOrder: 1, name: "A 组", config: {} },
    ],
    groups: [],
    entries: [],
  };

  function mockApi(over: Record<string, unknown> = {}) {
    apiMock.mockImplementation(async (path: string) => {
      if (path in over) return over[path];
      if (path === "/api/public/announcement") return { announcement: null };
      if (path === "/api/public/tournaments/1") return detail;
      if (path === "/api/public/tournaments/1/matches/summary") return { recent: [], upcoming: [] };
      if (path === "/api/public/tournaments/1/matches/rounds") return { stages: [] };
      throw new Error(`unexpected api path: ${path}`);
    });
  }

  function mountPage() {
    mount(
      <MemoryRouter initialEntries={["/t/1"]}>
        <Routes>
          <Route path="/t/:id" element={<PublicTournament />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("淘汰阶段零场次：显示「赛程待编排」而不是通用空文案", async () => {
    mockApi();
    mountPage();
    await flush();
    expect(host!.textContent).toContain("复赛");
    expect(host!.textContent).toContain("赛程待编排");
    expect(host!.textContent).not.toContain("赛程还没排出来");
  });

  it("有轮次时按两回合分块渲染，并显示总比分", async () => {
    mockApi({
      "/api/public/tournaments/1/matches?stageId=9&round=1": {
        matches: [
          match({ id: 71, stageId: 9, slot: 1, leg: 1, homeEntryId: 1, awayEntryId: 2, homeTeamName: "北京", awayTeamName: "上海", scoreHome: 3, scoreAway: 1, status: "finished", winnerEntryId: 1 }),
          match({ id: 72, stageId: 9, slot: 1, leg: 2, homeEntryId: 2, awayEntryId: 1, homeTeamName: "上海", awayTeamName: "北京", scoreHome: 0, scoreAway: 2, status: "finished", winnerEntryId: 1 }),
        ],
      },
      "/api/public/tournaments/1/matches/rounds": {
        stages: [
          { stageId: 9, name: "复赛", kind: "elim", sortOrder: 2, rounds: [{ round: 1, count: 2, live: 0, finished: 2, pending: 0 }] },
        ],
      },
    });
    mountPage();
    await flush();
    expect(host!.textContent).toContain("首回合");
    expect(host!.textContent).toContain("次回合");
    expect(host!.textContent).toContain("总比分");
    expect(host!.textContent).not.toContain("赛程待编排");
  });
});
