// @vitest-environment jsdom
// 手机底部弹层：槽位标题、候选排序 + 恒末位的「不指定」、选中 / 互斥标记、点行回写草稿。
// 沿用 tests/public.schedule.ui.test.tsx 的手搓根节点范式（仓库未装 @testing-library）。
import { afterEach, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssignSheet } from "../src/components/AssignSheet";
import type { AssignCandidateItem } from "../src/components/AssignCandidate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  host?.remove();
  host = null;
});

function candidate(over: Partial<AssignCandidateItem> & { playerId: number }): AssignCandidateItem {
  return { name: null, number: null, ...over };
}

function rows(): HTMLElement[] {
  return [...host!.querySelectorAll<HTMLElement>(".asg-row")];
}

describe("手机底部弹层（AssignSheet）", () => {
  it("标题写槽位与所属组，候选池为空时给出提示", () => {
    mount(
      <AssignSheet
        assignKey="ca_left"
        players={[]}
        assign={{}}
        suffixOf={() => ""}
        onPick={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = host!.querySelector(".asg-sheet")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("角球进攻 · 左侧角球");
    expect(host!.querySelector(".asg-sheet-body")!.textContent).toContain("场上 11 个位置还没选满");
    expect(rows()).toHaveLength(0);
  });

  it("按相关性排序、同一分按球衣号，「不指定」恒在最后一行且标出当前选中", () => {
    mount(
      <AssignSheet
        assignKey="ca_left"
        players={[
          // 身高 190 → 32 分，但对上限是 196（40 分）的那位要排在后面
          candidate({ playerId: 7, name: "张三", number: "9", meta: { height: 190 } }),
          candidate({ playerId: 8, name: "李四", number: "4", meta: { height: 196 } }),
        ]}
        assign={{ ca_left: 7 }}
        suffixOf={() => ""}
        onPick={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    const list = rows();
    expect(list).toHaveLength(3);
    expect(list[0].textContent).toContain("李四");
    expect(list[1].textContent).toContain("张三");
    expect(list[1].getAttribute("aria-pressed")).toBe("true");
    expect(list[1].textContent).toContain("✓ 当前");
    expect(list[2].classList.contains("asg-none")).toBe(true);
    expect(list[2].getAttribute("aria-pressed")).toBe("false");
  });

  it("点候选行回写该球员，点「不指定」清空该槽", () => {
    const picked: number[] = [];
    let cleared = 0;
    mount(
      <AssignSheet
        assignKey="fk_long"
        players={[candidate({ playerId: 3, name: "王五", number: "10" })]}
        assign={{}}
        suffixOf={() => ""}
        onPick={(pid) => picked.push(pid)}
        onClear={() => {
          cleared += 1;
        }}
        onClose={() => {}}
      />,
    );
    const list = rows();
    // 未填时「不指定」就是选中态
    expect(list[1].getAttribute("aria-pressed")).toBe("true");
    act(() => list[0].click());
    act(() => list[1].click());
    expect(picked).toEqual([3]);
    expect(cleared).toBe(1);
  });

  it("互斥撞车标红但仍可点；没 FC26 数据的球员给「无数据」徽标", () => {
    mount(
      <AssignSheet
        assignKey="ca_left"
        players={[
          candidate({ playerId: 7, name: "张三", number: "9", meta: { height: 190 } }),
          candidate({ playerId: 9, name: "赵六", number: "21" }),
        ]}
        // 张三是角球射门时的目标球员：再让他开角球就撞互斥
        assign={{ ca_left: 9, ca_target: 7 }}
        suffixOf={() => ""}
        onPick={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    const list = rows();
    const zhang = list.find((r) => r.textContent!.includes("张三"))!;
    expect(zhang.textContent).toContain("⚠ 已指定：角球进攻 · 目标球员");
    expect(zhang.textContent).toContain("身高 190");
    const zhao = list.find((r) => r.textContent!.includes("赵六"))!;
    expect(zhao.textContent).toContain("无数据");
    // 冲突不拦点击
    expect(zhang.getAttribute("aria-pressed")).toBe("false");
  });

  it("金徽优先：带 105 的球员显示金 chip（死球 / 精准头球那套按角色取）", () => {
    mount(
      <AssignSheet
        assignKey="ca_left"
        players={[
          candidate({
            playerId: 5,
            name: "钱七",
            number: "2",
            meta: { height: 185, playstyles: [5, 105] },
          }),
        ]}
        assign={{}}
        suffixOf={() => ""}
        onPick={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    const chip = rows()[0].querySelector(".asg-chip")!;
    expect(chip.classList.contains("gold")).toBe(true);
    expect(chip.textContent).toBe("精准头球 +");
  });

  it("按 Esc 关掉弹层（外接键盘 / 桌面窗口都好收），别的键不关", () => {
    let closed = 0;
    mount(
      <AssignSheet
        assignKey="ti_right"
        players={[candidate({ playerId: 7, name: "张三", number: "9" })]}
        assign={{}}
        suffixOf={() => ""}
        onPick={() => {}}
        onClear={() => {}}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(closed).toBe(0);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
  });
});
