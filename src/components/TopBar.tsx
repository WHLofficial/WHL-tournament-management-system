import { Link } from "react-router";
import { ROLE_LABEL, useAuth } from "../auth";

export function TopBar() {
  const { user, loading, logout } = useAuth();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        WHL 赛事系统
      </Link>
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
