import { useAuth } from "../auth";
import { Page } from "../components/ui";

export function AdminHome() {
  const { user } = useAuth();
  return (
    <Page>
      <h2>管理后台</h2>
      <p>
        {user?.name}（{user?.role}）已登录。赛事管理功能建设中。
      </p>
    </Page>
  );
}
