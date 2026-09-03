import { Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { RequireRole } from "./components/ui";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { AdminHome } from "./pages/AdminHome";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/admin"
          element={
            <RequireRole roles={["admin", "superadmin"]}>
              <AdminHome />
            </RequireRole>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
