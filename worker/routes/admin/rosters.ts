// v4.0.0 步骤 10：名册同步的手动入口。
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
import { metaSyncLog, syncPlayerMeta } from "../../lib/clubMeta";
import { fetchClubSquads, syncRosters } from "../../lib/clubRoster";
import { rebuildPlayerHistory, runHistoryBackfill } from "../../lib/playerHistory";

const app = new Hono<AppEnv>();

app.post("/sync-rosters", async (c) => {
  const base = c.env.CLUB_API_BASE;
  if (!base) {
    return c.json({ message: "未配置 CLUB_API_BASE，无法拉取俱乐部平台名册" }, 500);
  }
  const dryRun = c.req.query("dryRun") === "1";
  // force=1 只跳过骤降防护（某队一次消失过半时照常关窗），给「真的整队解散」用
  const force = c.req.query("force") === "1";

  let squads;
  try {
    squads = await fetchClubSquads(base);
  } catch (e) {
    // 拉不到就什么都不做（快照缺失会让「club 无」对每一行都为真 ⇒ 误关全库窗口）
    return c.json(
      { message: `拉取俱乐部平台名册失败：${e instanceof Error ? e.message : String(e)}` },
      502
    );
  }

  let result;
  try {
    result = await syncRosters(c.env.DB, squads, { dryRun, force });
  } catch (e) {
    return c.json({ message: e instanceof Error ? e.message : "同步失败" }, 400);
  }
  const { touchedPlayerIds, ...summary } = result;

  if (!dryRun) {
    await accountAuditStmt(c.env.DB, c.get("user")!.id, "player.sync_rosters", null, {
      teams: summary.teams,
      desired: summary.desired,
      inserted: summary.inserted,
      teamMoved: summary.teamMoved,
      renamed: summary.renamed,
      renumbered: summary.renumbered,
      stale: summary.stale,
      opened: summary.opened,
      closed: summary.closed,
      departed: summary.departed,
      skippedTeams: summary.skippedTeams,
      deleted: summary.deleted,
      kept: summary.kept.length,
    }).run();

    // 名册落库后，对本轮动过的人按「刚观察到的归属」重建履历：同步路径最清楚
    // 「这个人在哪支队」，转会记录接口只用来补历史，不该反过来覆盖当前状态。
    // 单个人重建失败只记日志——一条转会记录接口抖动不该让整个手动同步报错。
    const observedAt = new Date().toISOString();
    const teamRows = await c.env.DB.prepare("SELECT id FROM team").all<{ id: number }>();
    const knownTeams = new Set(teamRows.results.map((r) => r.id));
    const wanted = new Map<number, number>();
    for (const sq of squads) {
      if (!knownTeams.has(sq.clubId)) continue;
      for (const p of sq.players) wanted.set(p.fcId, sq.clubId);
    }
    for (const id of touchedPlayerIds) {
      try {
        await rebuildPlayerHistory(c.env.DB, id, {
          apiBase: base,
          mode: "sync",
          observed: { teamId: wanted.get(id) ?? null, at: observedAt },
          knownTeams,
        });
      } catch (e) {
        console.error(
          `[player-history] 同步重建失败 player=${id}：${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    try {
      const r = await runHistoryBackfill(c.env, { skip: new Set(touchedPlayerIds) });
      console.log(
        `[player-history] 回填 ${r.attempted} 人：成功 ${r.succeeded}、失败 ${r.failed}、跳过 ${r.skipped}`
      );
    } catch (e) {
      console.error(`[player-history] 回填失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // 名册落库之后再补球员元数据（FC26 属性 / 徽章 / 身高，见 lib/clubMeta.ts）。
    // dryRun 完全不碰 meta：那个开关的语义是「只看名册对账预期」，顺手多打一批 club 请求
    // 会把这个语义搅浑。meta 失败不影响本响应的契约（内部只记日志，返回值仅供日志用）。
    try {
      const fcIds = squads.flatMap((sq) => sq.players.map((p) => p.fcId));
      console.log(metaSyncLog(await syncPlayerMeta(c.env, fcIds)));
    } catch (e) {
      console.error(
        `[sync-player-meta] 意外失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return c.json({ ok: true, ...summary });
});

export default app;
