// 顶栏 ≡ 菜单静态锁：文本扫描闸门，卡「组件测试看不出的回归」——登出被搬回平铺、
// 菜单掉进登录态条件里、旧 .tz-* 选择器回潮（对照 club v6.41.0 TC-MENU-11/12/13 骨架）。
// 判据自检：锚点选不到时直接红，防止扫描在悄悄失焦（沿用 tests/datetime-display.test.ts 口径）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const topbar = readFileSync("src/components/TopBar.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

/** 菜单切片：弹层开标签到登出按钮确认文案之间，覆盖整个登出按钮，只允许时区成员 */
function menuSlice(): string {
  const popupIdx = topbar.indexOf('className="user-menu"');
  // 文案在登出按钮上方的 JSX 注释里也出现一次，取最后一次（按钮内容处）作切片终点
  const endIdx = topbar.lastIndexOf("再点一次确认退出");
  expect(popupIdx, '锚点缺失：弹层 .user-menu').toBeGreaterThanOrEqual(0);
  expect(endIdx, "锚点缺失：登出确认文案").toBeGreaterThanOrEqual(0);
  return topbar.slice(popupIdx, endIdx);
}

describe("v5.7.3 顶栏 ≡ 菜单静态锁（TC-MENU-11/12/13）", () => {
  it("TC-MENU-11 aria 契约与三条横线图标在场", () => {
    // 按钮：无障碍名 + 菜单语义 + 展开态 + 三条横线 path（与 club 同一 path，跨仓一致）。
    // aria 属性锚进 ≡ 按钮自身的标签片段——nav-menu 按钮也有 aria-haspopup，全局 toContain 挡不住漏删
    const btnIdx = topbar.indexOf('className="user-menu-btn"');
    const btnEnd = topbar.indexOf("aria-expanded={userMenuOpen}");
    expect(btnIdx, "锚点缺失：≡ 按钮").toBeGreaterThanOrEqual(0);
    expect(btnEnd, "锚点缺失：aria-expanded").toBeGreaterThan(btnIdx);
    const btnBlock = topbar.slice(btnIdx, btnEnd + "aria-expanded={userMenuOpen}".length);
    expect(btnBlock).toContain('aria-label="菜单"');
    expect(btnBlock).toContain('aria-haspopup="menu"');
    expect(btnBlock).toContain("aria-expanded={userMenuOpen}");
    expect(topbar).toContain('d="M4 7h16M4 12h16M4 17h16"');
    // 弹层与时区档：role=menu / menuitemradio + aria-checked
    expect(topbar).toContain('className="user-menu" role="menu"');
    expect(menuSlice()).toContain('role="menuitemradio"');
    expect(menuSlice()).toContain("aria-checked={tz === value}");
    // 登出项与分隔线
    expect(menuSlice()).toContain('role="menuitem"');
    expect(menuSlice()).toContain('role="separator"');
  });

  it("TC-MENU-12 索引序「菜单容器 < 弹层 < 登出」，切片成员只有时区与登出，无平铺残留", () => {
    const wrapIdx = topbar.indexOf('className="user-menu-wrap"');
    const popupIdx = topbar.indexOf('className="user-menu"');
    const logoutIdx = topbar.indexOf("menu-logout");
    expect(wrapIdx, "锚点缺失：菜单容器").toBeGreaterThanOrEqual(0);
    expect(wrapIdx).toBeLessThan(popupIdx);
    expect(popupIdx).toBeLessThan(logoutIdx);

    const slice = menuSlice();
    // 弹层成员：小标题、三档 map、分隔线、两段式确认文案
    expect(slice).toContain("user-menu-head");
    expect(slice).toContain("显示时区：");
    expect(slice).toContain("TZ_OPTIONS.map");
    expect(slice).toContain("user-menu-sep");
    expect(slice).toContain("requestLogout");
    expect(slice).toContain("再点一次确认退出");
    // 平铺时代的成员不得混进菜单切片
    expect(slice).not.toContain("userbox");
    expect(slice).not.toContain("btn-danger");
    expect(slice).not.toContain("tz-wrap");
    expect(slice).not.toContain("tz-btn");
    expect(slice).not.toContain("tz-pop");
  });

  it("TC-MENU-13 菜单在用户三态条件之后渲染、旧 .tz-* 零残留、CSS 规则在场", () => {
    // 三态条件末支（未登录分支的注册链接）在菜单容器之前 ⇒ 未登录也渲染 ≡
    const regIdx = topbar.lastIndexOf('to="/register">注册');
    const wrapIdx = topbar.indexOf('className="user-menu-wrap"');
    expect(regIdx, "锚点缺失：未登录分支注册链接").toBeGreaterThanOrEqual(0);
    expect(wrapIdx).toBeGreaterThan(regIdx);

    // 组件源码零残留：旧时区下拉类名清零（注释里的考古线索不禁，禁的是用法）
    expect(topbar).not.toContain('className="tz-');
    expect(topbar).not.toContain(".tz-wrap");
    expect(topbar).not.toContain(".tz-btn");
    expect(topbar).not.toContain(".tz-pop");

    // CSS：三条规则在场 + 右锚/浮层定位锚进 .user-menu 规则块（right:0 全文件 5 处，全局断言挡不住漏改）
    expect(styles).toContain(".user-menu-wrap {");
    expect(styles).toContain(".user-menu-btn {");
    expect(styles).toContain(".user-menu {");
    expect(styles).toContain(".user-menu-sep");
    expect(styles).toContain("menu-logout");
    const menuIdx = styles.indexOf(".user-menu {");
    const menuBlock = styles.slice(menuIdx, styles.indexOf("}", menuIdx));
    expect(menuBlock).toContain("right: 0");
    expect(menuBlock).toContain("top: calc(100% + 10px)");
    expect(menuBlock).toContain("min-width: 148px");
    // 注释里的考古线索（「原 .tz-wrap/.tz-pop」）不禁，禁的是选择器规则回潮
    expect(styles.search(/\.tz-(wrap|btn|pop)\s*[,{]/)).toBe(-1);
  });
});
