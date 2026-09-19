import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { boundAccounts } from "../../lib/authClient";
import { auditStmt } from "../../lib/audit";
import { accountNames, listGrants, matchInfo, revokeGrant, upsertGrant } from "../../lib/lineupProxy";
import type { ProxyGrantCandidateDTO, ProxyMatchSidesDTO } from "../../../shared/types";

// 阵容代打授权（migration 0023）。挂在 /api/admin 下，继承 admin.ts 的
// requirePermission("tour.match.manage")——即录入员也能授权（授权点就在赛事管理首页）。
const app = new Hono<AppEnv>();

function asId(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 授权清单，含已撤销与已开赛的（用 active 标出，便于管理员看出哪些已经自然失效）
app.get("/", async (c) => {
  const tid = asId(c.req.query("tournamentId"));
  const acct = accountNames(await boundAccounts(c.env));
  const grants = await listGrants(c.env.DB, { tournamentId: tid }, acct);
  return c.json({ grants });
});

// 候选账号：认证中心里的全部账号（姓名取 auth 库 account.name——OIDC 收口后新账号
// 在本库 user 表没有行，拿本库 JOIN 姓名会正好漏掉要授权的那批人）。
// 未绑队的也会列出来并标「未绑队」：当代打者不需要绑队，被代打方才需要。
app.get("/context", async (c) => {
  const rows = await boundAccounts(c.env);
  const accounts: ProxyGrantCandidateDTO[] = rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    teamId: r.teamId,
    teamName: r.teamName,
  }));
  return c.json({ accounts });
});

// 选好比赛后取两队 id 与已有授权（比赛列表的 DTO 里没有 team id，只能另取）
app.get("/match/:mid", async (c) => {
  const mid = asId(c.req.param("mid"));
  if (!mid) return c.json({ message: "比赛不存在" }, 404);
  const info = await matchInfo(c.env.DB, mid);
  if (!info) return c.json({ message: "比赛不存在" }, 404);
  const acct = accountNames(await boundAccounts(c.env));
  const grants = await listGrants(c.env.DB, { matchId: mid }, acct);
  const body: ProxyMatchSidesDTO = { ...info, grants };
  return c.json(body);
});

// 建授权：把「本场本队的阵容提交权」授给某账号。
// 只有未开打的比赛能授权（开打即失效，所以没必要给 expires_at）。
app.post("/", async (c) => {
  const user = c.get("user")!;
  const body = await c.req
    .json<{ matchId?: unknown; teamId?: unknown; granteeUserId?: unknown }>()
    .catch(() => null);
  const matchId = Number(body?.matchId);
  const teamId = Number(body?.teamId);
  const granteeUserId = Number(body?.granteeUserId);
  if (!Number.isInteger(matchId) || !Number.isInteger(teamId) || !Number.isInteger(granteeUserId)) {
    return c.json({ message: "请求格式不对" }, 400);
  }

  const info = await matchInfo(c.env.DB, matchId);
  if (!info) return c.json({ message: "比赛不存在" }, 404);
  if (info.status !== "pending") return c.json({ message: "比赛已开打，不能再授权代打" }, 409);
  if (teamId !== info.homeTeamId && teamId !== info.awayTeamId) {
    return c.json({ message: "该球队不在本场比赛中" }, 400);
  }

  const accounts = await boundAccounts(c.env);
  const grantee = accounts.find((a) => a.userId === granteeUserId);
  if (!grantee) return c.json({ message: "账号不存在" }, 400);
  // 授权去代打他自己绑定的球队，只会把他自己锁在门外，必然是操作失误
  if (grantee.teamId === teamId) {
    return c.json({ message: "该账号本来就绑这支球队，不需要代打授权" }, 400);
  }

  const grantId = await upsertGrant(c.env.DB, {
    matchId,
    teamId,
    granteeUserId,
    grantedBy: user.id,
  });
  await auditStmt(c.env.DB, user.id, "lineup_proxy_grant", matchId, {
    grantId,
    teamId,
    granteeUserId,
  }).run();
  return c.json({ ok: true, grantId });
});

// 撤销：置 revoked_at 不硬删（留痕），撤销后本队教练立刻能自己交
app.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const id = asId(c.req.param("id"));
  if (!id) return c.json({ message: "授权不存在" }, 404);
  const matchId = await revokeGrant(c.env.DB, id);
  if (matchId == null) return c.json({ message: "授权不存在或已撤销" }, 404);
  await auditStmt(c.env.DB, user.id, "lineup_proxy_revoke", matchId, { grantId: id }).run();
  return c.json({ ok: true });
});

export default app;
