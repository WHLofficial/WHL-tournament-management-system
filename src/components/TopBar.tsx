import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ROLE_LABEL, useAuth } from "../auth";
import { CreditsButton } from "./Credits";

export function TopBar() {
  const { user, loading, logout } = useAuth();
  const forced = user?.mustChangePassword === true;
  // 登出两段式确认：点一下进入待确认，再点才真登出，5 秒不点自动还原
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  function requestLogout() {
    if (!confirming) {
      setConfirming(true);
      timer.current = window.setTimeout(() => setConfirming(false), 5000);
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    void logout();
  }
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        WHL 赛事系统
      </Link>
      <nav className="nav-links">
        {!forced && <Link to="/tactics">战术板</Link>}
        {user && !forced && (user.role === "admin" || user.role === "superadmin") ? (
          <>
            <Link to="/admin">赛事管理</Link>
            <Link to="/admin/teams">球队库</Link>
            <Link to="/admin/codes">注册码</Link>
            {user.role === "superadmin" ? <Link to="/admin/accounts">账号管理</Link> : null}
          </>
        ) : null}
        {user && !forced ? <Link to="/my-team">我的球队</Link> : null}
        {!forced && <CreditsButton />}
      </nav>
      {loading ? null : user ? (
        <span className="userbox">
          {user.name}
          <span className="role-badge">{user.locked ? "观众" : ROLE_LABEL[user.role]}</span>
          <Link to="/password">改密码</Link>
          <button
            className={`btn ${confirming ? "btn-danger" : "btn-ghost"}`}
            onClick={requestLogout}
          >
            {confirming ? "再点一次确认退出" : "登出"}
          </button>
        </span>
      ) : (
        <span className="userbox">
          <Link to="/login">登录</Link>
          <Link to="/register">注册</Link>
        </span>
      )}
    </header>
  );
}
