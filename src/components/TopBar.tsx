import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ROLE_LABEL, useAuth } from "../auth";
import { GUESS_URL } from "../lib/links";
import { CreditsButton } from "./Credits";

/** 账号相关的三个工具页收进「账号与审计」下拉；组里只剩一项时直接当普通链接显示 */
type NavItem = { to: string; label: string };

export function TopBar() {
  const { user, loading, logout, authMode, authHome } = useAuth();
  const { pathname } = useLocation();
  const forced = user?.mustChangePassword === true;
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";
  // 登出两段式确认：点一下进入待确认，再点才真登出，5 秒不点自动还原
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  // 下拉：Esc 关闭、点外部关闭、换页自动收起
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  function requestLogout() {
    if (!confirming) {
      setConfirming(true);
      timer.current = window.setTimeout(() => setConfirming(false), 5000);
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    void logout();
  }

  const accountMenu: NavItem[] = [
    { to: "/admin/codes", label: "注册码" },
    ...(user?.role === "superadmin"
      ? [
          { to: "/admin/accounts", label: "账号管理" },
          { to: "/admin/audit", label: "审计日志" },
        ]
      : []),
  ];
  // 当前页高亮：赛事管理只管 /admin 与赛事详情（/admin/t/:id），其余按前缀认领
  const on = {
    tactics: pathname === "/tactics",
    team: pathname.startsWith("/my-team"),
    admin: pathname === "/admin" || pathname.startsWith("/admin/t/"),
    teams: pathname.startsWith("/admin/teams"),
    injuries: pathname.startsWith("/admin/injuries"),
    account: accountMenu.some((m) => pathname.startsWith(m.to)),
  };
  const cls = (active: boolean) => (active ? "on" : undefined);

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        WHL 赛事系统
      </Link>
      <nav className="nav-links">
        {!forced && (
          <Link to="/tactics" className={cls(on.tactics)}>
            战术板
          </Link>
        )}
        {user && !forced ? (
          <Link to="/my-team" className={cls(on.team)}>
            我的球队
          </Link>
        ) : null}
        {user && !forced && isAdmin ? (
          <>
            <span className="nav-sep" aria-hidden="true" />
            <Link to="/admin" className={cls(on.admin)}>
              赛事管理
            </Link>
            <Link to="/admin/teams" className={cls(on.teams)}>
              球队库
            </Link>
            <Link to="/admin/injuries" className={cls(on.injuries)}>
              伤停管理
            </Link>
            {accountMenu.length === 1 ? (
              <Link to={accountMenu[0].to} className={cls(on.account)}>
                {accountMenu[0].label}
              </Link>
            ) : (
              <div className="nav-menu" ref={menuRef}>
                <button
                  type="button"
                  className={`nav-menu-btn${on.account ? " on" : ""}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  账号与审计
                  <i className="nav-caret" aria-hidden="true">
                    ▾
                  </i>
                </button>
                {menuOpen ? (
                  <div className="nav-menu-list" role="menu">
                    {accountMenu.map((m) => (
                      <Link key={m.to} to={m.to} role="menuitem" className={cls(pathname.startsWith(m.to))}>
                        {m.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </>
        ) : null}
      </nav>
      <div className="topbar-right">
        {!forced && <CreditsButton />}
        {!forced && (
          <a className="btn-guess" href={GUESS_URL} target="_blank" rel="noopener noreferrer">
            去竞猜站↗
          </a>
        )}
        {loading ? null : user ? (
          <span className="userbox">
            {user.name}
            <span className="role-badge">{user.locked ? "观众" : ROLE_LABEL[user.role]}</span>
            {authMode === "oidc" ? (
              <a href={authHome ? `${authHome}/password` : "/password"}>改密码</a>
            ) : (
              <Link to="/password">改密码</Link>
            )}
            <button
              className={`btn ${confirming ? "btn-danger" : "btn-ghost"}`}
              onClick={requestLogout}
            >
              {confirming ? "再点一次确认退出" : "登出"}
            </button>
          </span>
        ) : (
          <span className="userbox">
            {authMode === "oidc" ? (
              <>
                {/* OIDC 模式：登录/注册入口指向本站 RP 发起端点与认证中心注册页 */}
                <a href="/api/auth/login">登录</a>
                <a href={authHome ? `${authHome}/register` : "/register"}>注册</a>
              </>
            ) : (
              <>
                <Link to="/login">登录</Link>
                <Link to="/register">注册</Link>
              </>
            )}
          </span>
        )}
      </div>
    </header>
  );
}
