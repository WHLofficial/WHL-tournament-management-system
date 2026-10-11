// @vitest-environment jsdom
// 管理端比赛 tab 默认轮：进行中轮 > 最早未开打轮（轮空场 status=pending 但不会再打，须排除）> 最后一轮。
// 口径与公开赛事页共用 shared/defaultRound.ts 单一实现。
// 仓库未装 @testing-library，沿用 tests/schedule.manual.ui.test.tsx 的 react-dom/client + act 手搓根节点范式。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import MatchesTab, { defaultRoundKey } from "../src/pages/MatchesTab";
import type { MatchDTO, StageDTO, TournamentDetailDTO } from "../shared/types";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: apiMock };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let unexpected: string[] = [];

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
  // MatchesTab 会 catch 掉取数错误，漏配 mock 不会自己变红，故这里显式断言
  expect(unexpected).toEqual([]);
  unexpected = [];
});

// 三轮回淘汰赛：第 1 轮 = 1/4 决赛、第 2 轮 = 半决赛、第 3 轮 = 决赛（elimRoundName 口径）
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
  stages: [{ id: 9, kind: "elim", sortOrder: 1, name: null, config: {} } as StageDTO],
  groups: [],
  entries: [],
};

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

/** 只放行进 tab 必发的两个请求；其余路径记入 unexpected 并抛错，避免 mock 漏配被静默吞掉 */
function prime(matches: MatchDTO[]) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/admin/tournaments/1/matches") return { matches };
    if (path === "/api/admin/tournaments/1/team-players") return { playersByTeam: {} };
    unexpected.push(path);
    throw new Error(`unexpected api path: ${path}`);
  });
}

function mountTab() {
  mount(<MatchesTab detail={detail} reload={() => {}} />);
}

function roundHead(): string {
  return host?.querySelector(".round-head")?.textContent ?? "";
}

describe("比赛 tab 默认轮", () => {
  it("无进行中时落到最早未开打的轮，而不是第一轮", async () => {
    prime([
      match({ id: 1, round: 1, status: "finished", scoreHome: 2, scoreAway: 1 }),
      match({ id: 2, round: 2, status: "pending" }),
      match({ id: 3, round: 3, status: "pending" }),
    ]);
    mountTab();
    await flush();
    expect(roundHead()).toBe("半决赛");
    expect(host?.querySelector(".rt-chip.rt-active")?.textContent).toContain("半决赛");
  });

  it("轮空场虽 status=pending 但不会再打：首轮打完就落到下一轮", async () => {
    prime([
      match({ id: 1, round: 1, status: "finished", scoreHome: 2, scoreAway: 1 }),
      match({ id: 2, round: 1, status: "pending", note: "轮空", winnerEntryId: 3 }),
      match({ id: 3, round: 2, status: "pending" }),
      match({ id: 4, round: 3, status: "pending" }),
    ]);
    mountTab();
    await flush();
    expect(roundHead()).toBe("半决赛");
  });

  it("有进行中的轮时优先落到该轮（哪怕后面还有未开打的轮）", async () => {
    prime([
      match({ id: 1, round: 1, status: "live", scoreHome: 1, scoreAway: 0 }),
      match({ id: 2, round: 2, status: "pending" }),
      match({ id: 3, round: 3, status: "pending" }),
    ]);
    mountTab();
    await flush();
    expect(roundHead()).toBe("1/4 决赛");
  });

  it("全部完赛时落到最后一轮（与公开页同口径）", async () => {
    prime([
      match({ id: 1, round: 1, status: "finished", scoreHome: 2, scoreAway: 1 }),
      match({ id: 2, round: 2, status: "finished", scoreHome: 0, scoreAway: 3 }),
      match({ id: 3, round: 3, status: "finished", scoreHome: 4, scoreAway: 2 }),
    ]);
    mountTab();
    await flush();
    expect(roundHead()).toBe("决赛");
  });
});

describe("defaultRoundKey", () => {
  it("空列表回 null", () => {
    expect(defaultRoundKey([])).toBeNull();
  });

  it("优先级：进行中 > 最早未开打 > 最后一轮", () => {
    const base = [
      { key: "9:1", live: 0, pending: 0 },
      { key: "9:2", live: 0, pending: 0 },
      { key: "9:3", live: 0, pending: 4 },
    ];
    // 无进行中：落到最早未开打（9:3），而不是第一轮（9:1）
    expect(defaultRoundKey(base)).toBe("9:3");
    // 有进行中：进行中优先，哪怕它出现在更早的轮
    expect(defaultRoundKey([{ key: "9:1", live: 1, pending: 0 }, ...base.slice(1)])).toBe("9:1");
    // 全部完赛：落到最后一轮（9:3）
    expect(defaultRoundKey(base.map((c) => ({ ...c, pending: 0 })))).toBe("9:3");
  });
});
