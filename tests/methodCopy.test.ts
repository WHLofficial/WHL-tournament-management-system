// methodCopy 词库结构断言（汇总自任务 3 草稿；钉 docs/news-method-copybank.md §2/§3/§4/§6 落地）：
// 每池 ≥6 计数、插槽齐全、组合表 19 组 + 通用 fallback、pen/own_goal 拒绝、solo/free_kick 无助攻、
// 红线全池零命中。pen_goal/own_goal 拒绝两列与 solo/free_kick 无助攻的路由级断言
// 在 tests/scoring.finish.routes.test.ts（POST/PUT 事件路由）覆盖，这里钉词表层不变量。
import { describe, it, expect } from "vitest";
import { ASSIST_METHODS, GOAL_METHODS } from "../shared/methods";
import {
  ASSIST_POOLS,
  METHOD_COMBOS,
  METHOD_POOLS,
  RED_LINE_RE,
  pickAssistLine,
  pickCombo,
  pickMethodLine,
} from "../worker/lib/methodCopy";

describe("methodCopy 词库结构（copybank §2/§3/§6）", () => {
  it("池键 = shared/methods.ts 枚举（14 进球 + 13 助攻）；pen_goal / own_goal 不进池", () => {
    expect(Object.keys(METHOD_POOLS).sort()).toEqual([...GOAL_METHODS].sort());
    expect(Object.keys(ASSIST_POOLS).sort()).toEqual([...ASSIST_METHODS].sort());
    expect(Object.keys(METHOD_POOLS)).not.toContain("pen_goal");
    expect(Object.keys(METHOD_POOLS)).not.toContain("own_goal");
  });

  it("每池 ≥6 全形 + 恰 2 短形；短形 ≤12 字且无插槽", () => {
    for (const [key, pool] of Object.entries(METHOD_POOLS)) {
      expect(pool.full.length, `goal ${key}`).toBeGreaterThanOrEqual(6);
      expect(pool.short.length, `goal ${key}`).toBe(2);
      for (const s of pool.short) {
        expect([...s].length, `goal ${key} 短形「${s}」`).toBeLessThanOrEqual(12);
        expect(s, `goal ${key} 短形「${s}」`).not.toMatch(/\{[APT]\}/);
      }
    }
    for (const [key, pool] of Object.entries(ASSIST_POOLS)) {
      expect(pool.full.length, `assist ${key}`).toBeGreaterThanOrEqual(6);
      expect(pool.short.length, `assist ${key}`).toBe(2);
      for (const s of pool.short) {
        expect([...s].length, `assist ${key} 短形「${s}」`).toBeLessThanOrEqual(12);
        expect(s, `assist ${key} 短形「${s}」`).not.toMatch(/\{[APT]\}/);
      }
    }
  });

  it("插槽齐全：进球池全形带 {P}，助攻池全形带 {A}", () => {
    for (const [key, pool] of Object.entries(METHOD_POOLS)) {
      expect(pool.full.every((v) => v.includes("{P}")), `goal ${key}`).toBe(true);
    }
    for (const [key, pool] of Object.entries(ASSIST_POOLS)) {
      expect(pool.full.every((v) => v.includes("{A}")), `assist ${key}`).toBe(true);
    }
  });

  it("渲染后无残留占位符：全池变体填满 {P}/{T}（进球）与 {A}（助攻）后扫描零残留", () => {
    for (const [key, pool] of Object.entries(METHOD_POOLS)) {
      for (const v of pool.full) {
        const filled = v.replaceAll("{P}", "甲").replaceAll("{T}", "乙").replaceAll("{A}", "丙");
        expect(filled, `goal ${key}`).not.toMatch(/\{[APT]\}/);
      }
    }
    for (const [key, pool] of Object.entries(ASSIST_POOLS)) {
      for (const v of pool.full) {
        const filled = v.replaceAll("{A}", "丙").replaceAll("{P}", "甲").replaceAll("{T}", "乙");
        expect(filled, `assist ${key}`).not.toMatch(/\{[APT]\}/);
      }
    }
  });

  it("组合表 19 组（组 4 两键共用共 20 键），每键 ≥2 变体；solo / free_kick 无组合键；组 18 通配在", () => {
    expect(Object.keys(METHOD_COMBOS).length).toBe(20);
    for (const [key, variants] of Object.entries(METHOD_COMBOS)) {
      expect(variants.length, `combo ${key}`).toBeGreaterThanOrEqual(2);
    }
    expect(METHOD_COMBOS["cross_45|header"]).toBe(METHOD_COMBOS["cross_byline|header"]);
    expect(METHOD_COMBOS["*|rebound"]).toBeDefined();
    for (const key of Object.keys(METHOD_COMBOS)) {
      expect(key.startsWith("solo|") || key.startsWith("free_kick|"), key).toBe(false);
    }
  });

  it("组合表插槽齐全：全部变体填 {A}/{P}/{T} 后零残留", () => {
    for (const [key, variants] of Object.entries(METHOD_COMBOS)) {
      for (const v of variants) {
        const filled = v
          .replaceAll("{A}", "丙")
          .replaceAll("{P}", "甲")
          .replaceAll("{T}", "乙");
        expect(filled, `combo ${key}`).not.toMatch(/\{[APT]\}/);
      }
    }
  });

  it("红线回归：全池与组合表零命中（copybank §6 全量词表）", () => {
    for (const pool of [...Object.values(METHOD_POOLS), ...Object.values(ASSIST_POOLS)]) {
      for (const v of [...pool.full, ...pool.short]) {
        expect(RED_LINE_RE.test(v), v).toBe(false);
      }
    }
    for (const variants of Object.values(METHOD_COMBOS)) {
      for (const v of variants) expect(RED_LINE_RE.test(v), v).toBe(false);
    }
  });

  it("确定性：同 seed 同结果；片段不含分钟；渲染填插槽", () => {
    const a = pickMethodLine("1:101:long_shot", "long_shot", { P: "张三", T: "甲队" });
    const b = pickMethodLine("1:101:long_shot", "long_shot", { P: "张三", T: "甲队" });
    expect(a).toBe(b);
    expect(a).toContain("张三");
    expect(a).not.toMatch(/第 \d+ 分钟/);
    const al = pickAssistLine("1:102:cross_45", "cross_45", { A: "李四" });
    expect(al).toBe(pickAssistLine("1:102:cross_45", "cross_45", { A: "李四" }));
    expect(al).toContain("李四");
  });

  it("pickCombo：无助攻走进球池单句；专表命中（组 1/4/18）；通用 fallback 拼接", () => {
    // solo / free_kick 无助攻（录入端拒助攻），组合入口只走单句
    const solo = pickCombo("7:3", null, "solo", { P: "李四", T: "甲队" });
    expect(solo).toContain("李四");
    expect(solo).not.toContain("undefined");

    const c1 = pickCombo("9:1", "through_ball", "one_on_one", { A: "张三", P: "李四", T: "甲队" });
    expect(c1).toContain("张三");
    expect(c1).toContain("李四");

    const c4 = pickCombo("9:4", "cross_byline", "header", { A: "张三", P: "李四" });
    expect(c4).toContain("张三");
    expect(c4).toContain("李四");

    // 组 18 通配：rebound 进球 + 录了助攻（原射者）→ 专用句
    const c18 = pickCombo("9:18", "cross_45", "rebound", { A: "张三", P: "李四" });
    expect(c18).toContain("张三");
    expect(c18).toContain("李四");

    // 通用 fallback：专表未覆盖的搭配（corner_kick × volley）
    const gf = pickCombo("9:9", "corner_kick", "volley", { A: "张三", P: "李四", T: "甲队" });
    expect(gf).toContain("张三");
    expect(gf).toContain("李四");
    expect(gf).toContain("，");
    expect(gf).not.toContain("{A}");
    expect(gf).not.toContain("{P}");
    expect(gf).not.toContain("{T}");
  });
});
