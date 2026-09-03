import { Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { RequireRole } from "./components/ui";
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
      <Routes>
        <Route path="/" element={<Home />} />
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
    </AuthProvider>
  );
}
