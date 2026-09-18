// 磁贴摆位测试：钉死「92x44 的磁贴在任何阵型、任何屏幕下都不重叠」这条保证。
// 球场内框尺寸来自实测：桌面左列 480px（面板 480x624，球场 460x590）、
// 窄屏面板与桌面同一个比例 10/13（375 视口 → 球场 314x395；360 视口 → 299x375）。
// 299x375 是兜住的底：再窄，同位置同行的 32% 间距就装不下 92px 磁贴，
// 或者纵向 12% 的档距就装不下 44px 磁贴了（约 353px 视口是极限）。
import { describe, expect, it } from "vitest";
import { FORMS, PTE26, focusAbbr } from "../shared/tactics";
import {
  NAME_BASE_SIZE,
  TILE_H,
  TILE_NAME_MAX,
  TILE_W,
  heatSide,
  nameFontSize,
  surname,
  tilePositions,
} from "../src/lib/pitch";

const PITCHES: [string, number, number][] = [
  ["桌面 460x590", 460, 590],
  ["手机 314x395", 314, 395],
  ["窄屏 299x375", 299, 375],
];

describe("磁贴摆位", () => {
  it("29 种阵型在三种球场尺寸下都没有两块磁贴压在一起", () => {
    expect(FORMS).toHaveLength(29);
    const bad: string[] = [];
    for (const [label, w, h] of PITCHES) {
      for (const f of FORMS) {
        const xy = tilePositions(f.pos.map((p) => p.position));
        for (let i = 0; i < xy.length; i++) {
          for (let j = i + 1; j < xy.length; j++) {
            const dx = (Math.abs(xy[i][0] - xy[j][0]) * w) / 100;
            const dy = (Math.abs(xy[i][1] - xy[j][1]) * h) / 100;
            if (dx < TILE_W && dy < TILE_H) {
              bad.push(
                `${label} ${f.value} ${f.pos[i].position}×${f.pos[j].position} ` +
                  `dx${dx.toFixed(1)} dy${dy.toFixed(1)}`,
              );
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("12 个位置都有坐标，阵型里用到的位置都查得到", () => {
    for (const f of FORMS) {
      for (const p of f.pos) expect(tilePositions([p.position]), p.position).toHaveLength(1);
    }
  });
});

describe("热区取哪一侧（中轴线位置的左右变体）", () => {
  const side = (x: number) => heatSide(x) ?? "C";

  it("按磁贴横向落点分左右，正落在中线上不分左右", () => {
    expect(heatSide(20)).toBe("L");
    expect(heatSide(35)).toBe("L");
    expect(heatSide(50)).toBeNull();
    expect(heatSide(65)).toBe("R");
    expect(heatSide(80)).toBe("R");
  });

  it("四后卫的两个中卫分左右，三中卫的中间那个用默认那套", () => {
    for (const [value, want] of [
      ["433", ["L", "R"]],
      ["352", ["C", "L", "R"]],
    ] as [string, string[]][]) {
      const f = FORMS.find((x) => x.value === value)!;
      const xy = tilePositions(f.pos.map((p) => p.position));
      const cbs = xy.filter((_, i) => f.pos[i].position === "CB").map((p) => side(p[0]));
      expect(cbs.sort(), value).toEqual(want);
    }
  });
});

describe("磁贴上的名字", () => {
  it("只留最后一节", () => {
    expect(surname("Toni Kroos")).toBe("Kroos");
    expect(surname("  Hu Hetao ")).toBe("Hetao");
    expect(surname("Alexander-Arnold")).toBe("Alexander-Arnold");
    expect(surname("Kroos")).toBe("Kroos");
  });

  it("放得下就用基准字号，放不下按比例缩，最短 6px", () => {
    const measure = (text: string, size: number) => text.length * size;
    expect(TILE_NAME_MAX).toBe(TILE_W - 11);
    expect(nameFontSize("Kroos", 80, measure)).toBe(NAME_BASE_SIZE);
    expect(nameFontSize("Milinkovic", 80, measure)).toBe(8);
    expect(nameFontSize("A".repeat(100), 80, measure)).toBe(6);
  });

  it("量不出宽度时用基准字号（服务端/测试环境没有 canvas）", () => {
    expect(nameFontSize("Alexander-Arnold", 81)).toBe(NAME_BASE_SIZE);
  });
});

describe("重心缩写", () => {
  const focuses = [...new Set(Object.values(PTE26).flatMap((l) => l.map((e) => e.focus)))];

  it("PTE26 里的 10 个重心都有缩写，1-2 个大写字母且互不重复", () => {
    expect(focuses).toHaveLength(10);
    const abbrs = focuses.map((f) => focusAbbr(f));
    for (const a of abbrs) expect(a).toMatch(/^[A-Z]{1,2}$/);
    expect(new Set(abbrs).size).toBe(focuses.length);
  });

  it("角色码接上缩写、横杠两边带空格，最长 8 个字符，磁贴第一行放得下", () => {
    let max = 0;
    for (const list of Object.values(PTE26)) {
      for (const e of list) max = Math.max(max, `${e.role} - ${focusAbbr(e.focus)}`.length);
    }
    expect(max).toBeLessThanOrEqual(8);
  });
});
