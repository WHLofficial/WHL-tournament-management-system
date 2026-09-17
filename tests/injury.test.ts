import { describe, it, expect } from "vitest";
import { assembleRaw, type MissRow } from "../worker/lib/injury";
import {
  INJURY_CATALOG,
  findInjuryCatalog,
  injuryNamesOf,
  randomInjuryName,
  severityOfEventType,
} from "../shared/injuries";

const baseRow = {
  id: 1,
  team_id: 10,
  player_id: 100,
  event_id: 1000,
  injury_name: "踝关节扭伤",
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

describe("伤病名库", () => {
  it("名字唯一，两个档位都有三档以上常见度", () => {
    const names = new Set(INJURY_CATALOG.map((it) => it.name));
    expect(names.size).toBe(INJURY_CATALOG.length);
    for (const severity of ["minor", "major"] as const) {
      const weights = new Set(injuryNamesOf(severity).map((it) => it.weight));
      expect(weights.size).toBeGreaterThanOrEqual(3);
    }
    for (const it of INJURY_CATALOG) {
      expect(it.weight).toBeGreaterThanOrEqual(1);
      expect(it.weight).toBeLessThanOrEqual(4);
    }
  });

  it("injuryNamesOf 按常见度降序，且只含本档位", () => {
    for (const severity of ["minor", "major"] as const) {
      const list = injuryNamesOf(severity);
      expect(list.every((it) => it.severity === severity)).toBe(true);
      expect(list.map((it) => it.weight)).toEqual(
        [...list.map((it) => it.weight)].sort((a, b) => b - a),
      );
      expect(list.length).toBeGreaterThanOrEqual(10);
    }
  });

  it("randomInjuryName：同档位内按权重真随机，连抽不重复同一名字", () => {
    const count = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const n = randomInjuryName("minor");
      expect(findInjuryCatalog(n)!.severity).toBe("minor");
      count.set(n, (count.get(n) ?? 0) + 1);
    }
    // 踝关节扭伤 weight 4，牙齿折断 weight 1：期望 4:1，弱断言留足余量
    const common = count.get("踝关节扭伤") ?? 0;
    const rare = count.get("牙齿折断") ?? 0;
    expect(common).toBeGreaterThan(rare * 2);
    // 档位内的伤名应该大多能被抽到，而不是集中在一两条
    expect(count.size).toBeGreaterThanOrEqual(12);
    // 每次都要真的动起来：按 id/计数做种子的旧实现会抽出一串固定名字
    expect(new Set(Array.from({ length: 200 }, () => randomInjuryName("minor"))).size).toBeGreaterThanOrEqual(10);
    // avoid：刚抽到的名字不会连着再出现（连点「随机伤名」的手感）
    for (let i = 0; i < 300; i++) {
      expect(randomInjuryName("minor", "踝关节扭伤")).not.toBe("踝关节扭伤");
    }
    // 重档抽查：只出重档名，且含常见的跖骨骨折
    const majors = new Set(Array.from({ length: 200 }, () => randomInjuryName("major")));
    expect([...majors].every((n) => findInjuryCatalog(n)!.severity === "major")).toBe(true);
    expect(majors.has("跖骨骨折")).toBe(true);
  });

  it("findInjuryCatalog 与 severityOfEventType", () => {
    expect(findInjuryCatalog("跖骨骨折")?.severity).toBe("major");
    expect(findInjuryCatalog("不存在")).toBeNull();
    expect(severityOfEventType("injury_minor")).toBe("minor");
    expect(severityOfEventType("injury_major")).toBe("major");
  });
});
