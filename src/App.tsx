import { Route, Routes, useLocation } from "react-router";
import { AuthProvider } from "./auth";
import { RequireRole } from "./components/ui";
import { TopBar } from "./components/TopBar";
import { Home } from "./pages/Home";
import PublicTournament from "./pages/PublicTournament";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { AdminTournaments } from "./pages/AdminTournaments";
import { AdminTeams } from "./pages/AdminTeams";
import { AdminCodes } from "./pages/AdminCodes";
import { TeamDetailPage } from "./pages/TeamDetail";
import { TournamentManage } from "./pages/TournamentManage";
import MyTeam from "./pages/MyTeam";

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
  const bare = pathname === "/login" || pathname === "/register";
  return (
    <>
      {!bare && <TopBar />}
      <Routes>
        <Route
          path="/"
          element={
            <RequireRole roles={["coach", "admin", "superadmin"]}>
              <Home />
            </RequireRole>
          }
        />
        <Route path="/t/:id" element={<PublicTournament />} />
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
      </Routes>
    </>
  );
}
