import { Route, Routes, useLocation } from "react-router";
import { lazy, Suspense } from "react";
import { AuthProvider, useAuth } from "./auth";
import { RequireRole } from "./components/ui";
import { TopBar } from "./components/TopBar";
import { Home } from "./pages/Home";
import PublicTournament from "./pages/PublicTournament";
import PublicMatchDetail from "./pages/PublicMatchDetail";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import Tactics from "./pages/Tactics";
import { APP_VERSION } from "./lib/version";

// 管理端/个人页按路由拆包：公开访客不再下载管理端代码（主 bundle 402KB→瘦身）
const AdminTournaments = lazy(() =>
  import("./pages/AdminTournaments").then((m) => ({ default: m.AdminTournaments })),
);
const AdminTeams = lazy(() =>
  import("./pages/AdminTeams").then((m) => ({ default: m.AdminTeams })),
);
const AdminCodes = lazy(() =>
  import("./pages/AdminCodes").then((m) => ({ default: m.AdminCodes })),
);
const TeamDetailPage = lazy(() =>
  import("./pages/TeamDetail").then((m) => ({ default: m.TeamDetailPage })),
);
const AdminInjuries = lazy(() =>
  import("./pages/AdminInjuries").then((m) => ({ default: m.AdminInjuries })),
);
const TournamentManage = lazy(() =>
  import("./pages/TournamentManage").then((m) => ({ default: m.TournamentManage })),
);
const MyTeam = lazy(() => import("./pages/MyTeam"));
const Accounts = lazy(() =>
  import("./pages/Accounts").then((m) => ({ default: m.Accounts })),
);
const AuditLog = lazy(() =>
  import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })),
);
const ChangePassword = lazy(() =>
  import("./pages/ChangePassword").then((m) => ({ default: m.ChangePassword })),
);
// 头版门户详情页（公开，按路由拆包）
const ReportPage = lazy(() => import("./pages/ReportPage"));
const WeeklyPage = lazy(() => import("./pages/WeeklyPage"));
const RecapPage = lazy(() => import("./pages/RecapPage"));
const NewsPage = lazy(() => import("./pages/NewsPage"));

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

// TopBar 全局挂载，登录/注册页不显示
function AppShell() {
  const { pathname } = useLocation();
  const { user, loading } = useAuth();
  const bare = pathname === "/login" || pathname === "/register";
  // 登录态在途（me 未回来）：不渲染任何内容防「匿名→登录态」跳变闪屏；
  // me 带 syncProbe 时整页跳探测，看到的只是一瞬「加载中」
  if (loading) {
    return <div className="container"><p className="hint">加载中…</p></div>;
  }
  // 密码被重置后未改密：改密码卡盖在一切前面，改完自动消失
  const forced = user?.mustChangePassword === true;
  return (
    <>
      {!bare && <TopBar />}
      {forced ? (
        <Suspense fallback={<div className="container"><p className="hint">加载中…</p></div>}>
          <ChangePassword forced />
        </Suspense>
      ) : (
        <Suspense
          fallback={
            <div className="container">
              <p className="hint">加载中…</p>
            </div>
          }
        >
          <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/t/:id" element={<PublicTournament />} />
          <Route path="/tactics" element={<Tactics />} />
          <Route path="/t/:id/match/:mid" element={<PublicMatchDetail />} />
          <Route path="/report/:mid" element={<ReportPage />} />
          <Route path="/weekly" element={<WeeklyPage />} />
          <Route path="/recap/:tid/:sid/:round" element={<RecapPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route
            path="/my-team"
            element={
              <RequireRole roles={["coach", "admin", "superadmin"]}>
                <MyTeam />
              </RequireRole>
            }
          />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route
            path="/admin"
            element={
              <RequireRole roles={["admin", "superadmin"]}>
                <AdminTournaments />
              </RequireRole>
            }
          />
          <Route
            path="/admin/teams"
            element={
              <RequireRole roles={["admin", "superadmin"]}>
                <AdminTeams />
              </RequireRole>
            }
          />
          <Route
            path="/admin/codes"
            element={
              <RequireRole roles={["admin", "superadmin"]}>
                <AdminCodes />
              </RequireRole>
            }
          />
          <Route
            path="/admin/injuries"
            element={
              <RequireRole roles={["admin", "superadmin"]}>
                <AdminInjuries />
              </RequireRole>
            }
          />
          <Route
            path="/admin/teams/:id"
            element={
              <RequireRole roles={["admin", "superadmin"]}>
                <TeamDetailPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/t/:id"
            element={
              <RequireRole roles={["admin", "superadmin"]}>
                <TournamentManage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/accounts"
            element={
              <RequireRole roles={["superadmin"]}>
                <Accounts />
              </RequireRole>
            }
          />
          <Route
            path="/admin/audit"
            element={
              <RequireRole roles={["superadmin"]}>
                <AuditLog />
              </RequireRole>
            }
          />
          <Route
            path="/password"
            element={
              <RequireRole roles={["coach", "admin", "superadmin"]}>
                <ChangePassword />
              </RequireRole>
            }
          />
          </Routes>
        </Suspense>
      )}
      <footer className="app-footer">WHL 赛事系统 · v{APP_VERSION}</footer>
    </>
  );
}
