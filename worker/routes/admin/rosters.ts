// 增量 33 步骤 10：名册同步的手动入口。
//
// 定时任务每小时拉一次（wrangler.jsonc 的 triggers.crons），这个端点是给「刚签完约、马上要排阵容」
// 这种等不了的情形用的强制同步。两者走同一套 lib/clubRoster，语义完全一致。
//
// `?dryRun=1` 只算不写：首次上线前先跑一次看「新增/换队/改名/改号/删除」各是多少，
// 对上预期（号码 0 改动、名字一批被改写、0 增 0 删）再真正执行。
//
// 权限：挂在 /api/admin 下，自动吃 admin.ts 的 requirePermission("tour.match.manage") + 密码已改。
import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { accountAuditStmt } from "../../lib/audit";
import { fetchClubSquads, syncRosters } from "../../lib/clubRoster";

const app = new Hono<AppEnv>();

app.post("/sync-rosters", async (c) => {
  const base = c.env.CLUB_API_BASE;
  if (!base) {
    return c.json({ message: "未配置 CLUB_API_BASE，无法拉取俱乐部平台名册" }, 500);
  }
  const dryRun = c.req.query("dryRun") === "1";

  let squads;
  try {
    squads = await fetchClubSquads(base);
  } catch (e) {
    // 拉不到就什么都不做（快照缺失会让「club 无」对每一行都为真 ⇒ 误删全库）
    return c.json(
      { message: `拉取俱乐部平台名册失败：${e instanceof Error ? e.message : String(e)}` },
      502
    );
  }

  let summary;
  try {
    summary = await syncRosters(c.env.DB, squads, { dryRun });
  } catch (e) {
    return c.json({ message: e instanceof Error ? e.message : "同步失败" }, 400);
  }

  if (!dryRun) {
    await accountAuditStmt(c.env.DB, c.get("user")!.id, "player.sync_rosters", null, {
      teams: summary.teams,
      desired: summary.desired,
      inserted: summary.inserted,
      teamMoved: summary.teamMoved,
      renamed: summary.renamed,
      renumbered: summary.renumbered,
      deleted: summary.deleted,
      kept: summary.kept.length,
    }).run();
  }
  return c.json({ ok: true, ...summary });
});

export default app;
