import { Link } from "react-router";
import { ROLE_LABEL, useAuth } from "../auth";

export function TopBar() {
  const { user, loading, logout } = useAuth();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        WHL 赛事系统
      </Link>
      <nav className="nav-links">
        {user && (user.role === "admin" || user.role === "superadmin") ? (
          <>
            <Link to="/admin">赛事管理</Link>
            <Link to="/admin/teams">球队库</Link>
            <Link to="/admin/codes">注册码</Link>
          </>
        ) : null}
        {user ? <Link to="/my-team">我的球队</Link> : null}
      </nav>
      {loading ? null : user ? (
        <span className="userbox">
          {user.name}
          <span className="role-badge">{ROLE_LABEL[user.role]}</span>
          <button className="btn btn-ghost" onClick={() => void logout()}>
            登出
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
