import { Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { RequireRole } from "./components/ui";
import { Home } from "./pages/Home";
import PublicTournament from "./pages/PublicTournament";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { AdminTournaments } from "./pages/AdminTournaments";
import { AdminTeams } from "./pages/AdminTeams";
import { TeamDetailPage } from "./pages/TeamDetail";
import { TournamentManage } from "./pages/TournamentManage";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/t/:id" element={<PublicTournament />} />
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
