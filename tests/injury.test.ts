import { describe, it, expect } from "vitest";
import { assembleRaw, suggestMissIds, type MissRow } from "../worker/lib/injury";
import { INJURY_CATALOG, findInjuryCatalog, severityOfEventType } from "../shared/injuries";

const baseRow = {
  id: 1,
  team_id: 10,
  player_id: 100,
  event_id: 1000,
  injury_name: "轻微扭伤",
  note: null,
  created_at: "2026-01-01T00:00:00Z",
  event_type: "injury_minor" as const,
  event_minute: 30,
  player_name: "张三",
  from_match_id: 500,
  from_tournament_id: 7,
  from_tournament_name: "联赛",
  from_round: 3,
  from_stage_kind: "round_robin" as const,
};

const miss = (over: Partial<MissRow>): MissRow => ({
  injury_id: 1,
  match_id: 1,
  tournament_id: 7,
  tournament_name: "联赛",
  round: 4,
  stage_kind: "round_robin",
  status: "pending",
  ...over,
});

describe("assembleRaw", () => {
  it("按状态统计伤愈进度：1/3 完赛 = 33%", () => {
    const map = assembleRaw(
      [baseRow],
      [
        miss({ match_id: 11, status: "finished" }),
        miss({ match_id: 12, status: "pending" }),
        miss({ match_id: 13, status: "live" }),
      ]
    );
    const inj = map.get(1)!;
    expect(inj.recoverPercent).toBe(33);
    expect(inj.severity).toBe("minor");
    expect(inj.fromLabel).toBe("联赛 · 第3轮");
    expect(inj.misses.map((m) => m.matchId)).toEqual([11, 12, 13]);
  });

  it("全完赛 = 100%，零勾选 = 0%（仅存档不显示伤停中）", () => {
    const done = assembleRaw([baseRow], [miss({ match_id: 11, status: "finished" })]).get(1)!;
    expect(done.recoverPercent).toBe(100);
    const none = assembleRaw([baseRow], []).get(1)!;
    expect(none.recoverPercent).toBe(0);
  });

  it("重伤事件归 major 档，跨赛事缺阵保留各自赛事名", () => {
    const row = { ...baseRow, event_type: "injury_major" as const };
    const map = assembleRaw(
      [row],
      [
        miss({ match_id: 11, tournament_id: 7, tournament_name: "联赛" }),
        miss({ match_id: 99, tournament_id: 9, tournament_name: "冠军杯" }),
      ]
    );
    const inj = map.get(1)!;
    expect(inj.severity).toBe("major");
    expect(inj.misses.map((m) => m.tournamentName)).toEqual(["联赛", "冠军杯"]);
  });

  it("teamNameOf 注入队名；misses 归属错乱（foreign injury_id）被忽略", () => {
    const map = assembleRaw([{ ...baseRow, team_name: "红队" }], [miss({ injury_id: 999 })], (r) => r.team_name!);
    expect(map.get(1)!.teamName).toBe("红队");
    expect(map.get(1)!.misses).toEqual([]);
  });

  it("进度四舍五入：2/3 = 67%", () => {
    const map = assembleRaw(
      [baseRow],
      [miss({ match_id: 11, status: "finished" }), miss({ match_id: 12, status: "finished" }), miss({ match_id: 13, status: "pending" })]
    );
    expect(map.get(1)!.recoverPercent).toBe(67);
  });
});

describe("suggestMissIds", () => {
  const upcoming = [101, 102, 103, 104];

  it("按名库 suggestMiss 预勾前 N 场 pending", () => {
    expect(suggestMissIds(upcoming, "擦伤")).toEqual([]); // suggestMiss 0
    expect(suggestMissIds(upcoming, "轻微扭伤")).toEqual([101]);
    expect(suggestMissIds(upcoming, "脑震荡")).toEqual([101, 102, 103]);
  });

  it("pending 不足时有多少勾多少；库外名字返回空", () => {
    expect(suggestMissIds([101], "脑震荡")).toEqual([101]);
    expect(suggestMissIds(upcoming, "神秘的伤")).toEqual([]);
    expect(suggestMissIds(upcoming, null)).toEqual([]);
  });
});

describe("伤病名库", () => {
  it("每条都含 name/severity/suggestMiss，名字唯一", () => {
    const names = new Set(INJURY_CATALOG.map((it) => it.name));
    expect(names.size).toBe(INJURY_CATALOG.length);
    for (const it of INJURY_CATALOG) {
      expect(it.suggestMiss).toBeGreaterThanOrEqual(0);
      expect(it.suggestMiss).toBeLessThanOrEqual(4);
    }
  });

  it("轻伤档 suggestMiss ≤1，重伤档 ≥2（两周口径的场次表达）", () => {
    for (const it of INJURY_CATALOG) {
      if (it.severity === "minor") expect(it.suggestMiss).toBeLessThanOrEqual(1);
      else expect(it.suggestMiss).toBeGreaterThanOrEqual(2);
    }
  });

  it("findInjuryCatalog 与 severityOfEventType", () => {
    expect(findInjuryCatalog("骨折")?.severity).toBe("major");
    expect(findInjuryCatalog("不存在")).toBeNull();
    expect(severityOfEventType("injury_minor")).toBe("minor");
    expect(severityOfEventType("injury_major")).toBe("major");
  });
});
