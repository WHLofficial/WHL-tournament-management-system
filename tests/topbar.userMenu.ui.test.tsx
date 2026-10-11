// @vitest-environment jsdom
// 顶栏右上角 ≡ 菜单：平铺的「显示时区三档」与「登出」收进同一弹层（对照 club v6.41.0
// TC-MENU-01…06 骨架，按本仓形态调整）。仓库未装 @testing-library，
// 沿用 tests/public.schedule.ui.test.tsx 的 createRoot + act 手搓范式。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TopBar } from "../src/components/TopBar";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("../src/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth")>();
  return { ...actual, useAuth: () => authMock() };
});

function authState(over: Record<string, unknown> = {}) {
  return {
    user: null,
    loading: false,
    authMode: "shared",
    authHome: null,
    refresh: async () => {},
    applyUser: () => {},
    logout: vi.fn(async () => {}),
    ...over,
  };
}

const ME = { id: 7, name: "测试号", role: "admin", teamId: null, locked: false, mustChangePassword: false };

beforeEach(() => {
  // 时区偏好落在 localStorage（键 whl.tz），用例间必须清干净
  localStorage.clear();
  authMock.mockReturnValue(authState());
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function unmountCurrent() {
  const r = root;
  if (r) act(() => r.unmount());
  root = null;
  host?.remove();
  host = null;
}

function mount(node: ReactNode) {
  unmountCurrent();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

afterEach(() => {
  unmountCurrent();
  authMock.mockReset();
});

function mountTopBar() {
  mount(
    <MemoryRouter initialEntries={["/"]}>
      <TopBar />
    </MemoryRouter>,
  );
}

function menuBtn(): HTMLButtonElement {
  return host!.querySelector("button.user-menu-btn") as HTMLButtonElement;
}
function openMenu() {
  act(() => {
    menuBtn().click();
  });
}
function popup(): HTMLElement | null {
  return host!.querySelector(".user-menu");
}
function tzItems(): HTMLButtonElement[] {
  return [...host!.querySelectorAll('.user-menu [role="menuitemradio"]')] as HTMLButtonElement[];
}
function logoutItem(): HTMLButtonElement | null {
  return host!.querySelector('.user-menu button[role="menuitem"]');
}

describe("顶栏 ≡ 菜单（时区 + 登出收纳）", () => {
  it("未登录也渲染 ≡ 按钮，弹层只有时区三档与标题、无登出项", () => {
    mountTopBar();
    const btn = menuBtn();
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("菜单");
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    openMenu();
    const pop = popup();
    expect(pop?.getAttribute("role")).toBe("menu");
    expect(pop?.querySelector(".user-menu-head")?.textContent).toBe("显示时区：北京时间");
    expect(tzItems().map((b) => b.textContent)).toEqual(["✓ 北京时间", "UTC", "跟随浏览器"]);
    expect(tzItems()[0].getAttribute("aria-checked")).toBe("true");
    expect(tzItems()[1].getAttribute("aria-checked")).toBe("false");
    // 未登录没有登出项，也没有分隔线
    expect(logoutItem()).toBeNull();
    expect(host!.querySelector(".user-menu-sep")).toBeNull();
  });

  it("已登录（oidc）：登出在菜单内且两段式——第一击只进确认态，第二击才 logout", () => {
    const logout = vi.fn(async () => {});
    authMock.mockReturnValue(authState({ user: ME, authMode: "oidc", authHome: "https://auth.example", logout }));
    mountTopBar();

    openMenu();
    const item = logoutItem();
    expect(item?.textContent).toBe("登出");
    // 弹层里不应再有旧平铺的 btn-danger 登出按钮
    expect(host!.querySelector(".userbox button")).toBeNull();

    act(() => {
      item!.click();
    });
    expect(item!.textContent).toBe("再点一次确认退出");
    expect(item!.className).toContain("confirming");
    expect(logout).not.toHaveBeenCalled();

    act(() => {
      item!.click();
    });
    expect(logout).toHaveBeenCalledTimes(1);
    // 二击后菜单收起，不留停在匿名态；一击后（确认文案可见时）必须保持展开
    expect(host!.querySelector(".user-menu")).toBeNull();
  });

  it("已登录（shared）：登出同样收在菜单内", () => {
    authMock.mockReturnValue(authState({ user: ME, authMode: "shared" }));
    mountTopBar();
    openMenu();
    expect(logoutItem()?.textContent).toBe("登出");
    expect(host!.querySelector(".user-menu-sep")).toBeTruthy();
  });

  it("loading 中间态：≡ 仍在但用户区不渲染，菜单内只有时区三档", () => {
    authMock.mockReturnValue(authState({ loading: true }));
    mountTopBar();
    expect(menuBtn()).toBeTruthy();
    expect(host!.querySelector(".userbox")).toBeNull();
    openMenu();
    expect(tzItems()).toHaveLength(3);
    expect(logoutItem()).toBeNull();
  });

  it("点 UTC 档：写 whl.tz 偏好、派发 whl:tz-change、弹层收起、按钮 title 跟着变", () => {
    const events: string[] = [];
    window.addEventListener("whl:tz-change", () => events.push("tz-change"));
    mountTopBar();
    expect(menuBtn().title).toBe("菜单（显示时区：北京时间）");

    openMenu();
    act(() => {
      tzItems()[1].click();
    });
    expect(localStorage.getItem("whl.tz")).toBe("utc");
    expect(events).toEqual(["tz-change"]);
    // 选完即收，按钮 title 反映新档
    expect(popup()).toBeNull();
    expect(menuBtn().getAttribute("aria-expanded")).toBe("false");
    expect(menuBtn().title).toBe("菜单（显示时区：UTC）");
    window.removeEventListener("whl:tz-change", () => {});
  });

  it("Esc 与点外部关闭弹层，点菜单内部不关", () => {
    mountTopBar();

    openMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(popup()).toBeNull();

    openMenu();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(popup()).toBeNull();

    openMenu();
    act(() => {
      menuBtn().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(popup()).toBeTruthy();
  });

  it("登出进入确认态后 5 秒不点自动还原回「登出」", () => {
    vi.useFakeTimers();
    try {
      authMock.mockReturnValue(authState({ user: ME }));
      mountTopBar();
      openMenu();
      const item = logoutItem()!;
      act(() => {
        item.click();
      });
      expect(item.textContent).toBe("再点一次确认退出");
      expect(logoutItem()).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(logoutItem()?.textContent).toBe("登出");

      // 还原后再点两下仍能走完两段式
      act(() => {
        logoutItem()!.click();
      });
      expect(logoutItem()?.textContent).toBe("再点一次确认退出");
    } finally {
      vi.useRealTimers();
    }
  });

  it("≡ 菜单是右侧集群最后一格，用户区不再有平铺按钮", () => {
    authMock.mockReturnValue(authState({ user: ME, authMode: "oidc", authHome: "https://auth.example" }));
    mountTopBar();
    const right = host!.querySelector(".topbar-right") as HTMLElement;
    expect(right.lastElementChild?.classList.contains("user-menu-wrap")).toBe(true);
    // 用户区只剩用户名 / 徽章 / 改密码链接
    expect(host!.querySelector(".userbox button")).toBeNull();
    expect(host!.querySelector('.userbox a[href$="/password"]')).toBeTruthy();
  });
});
