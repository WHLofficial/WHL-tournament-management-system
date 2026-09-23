/** 冒烟：验证 vite-node 能直接加载真实 Hono 应用、假 D1 能抓到 SQL、管理通道能读回行读数。 */
import app from "../../worker/index";
import { captureSurface, costOf, explainPlan, oneLine, probeHeaders } from "./harness.mts";

const publicRes = await captureSurface(app, "https://probe.local/api/public/tournaments");
console.log(`[公开] /api/public/tournaments → ${publicRes.status}，${publicRes.statements.length} 条语句`);
if (publicRes.error) console.log("  错误：", publicRes.error);
for (const s of publicRes.statements) console.log(`  - ${oneLine(s.sql)} | args=${JSON.stringify(s.args)}`);

const adminRes = await captureSurface(app, "https://probe.local/api/admin/teams", {
  headers: probeHeaders(),
});
console.log(`[管理] /api/admin/teams → ${adminRes.status}，${adminRes.statements.length} 条语句`);
if (adminRes.error) console.log("  错误：", adminRes.error);
for (const s of adminRes.statements) console.log(`  - ${oneLine(s.sql)} | args=${JSON.stringify(s.args)}`);

if (publicRes.statements.length) {
  const cost = costOf(publicRes.statements);
  console.log(`[读数] /api/public/tournaments 合计 ${cost.total} 行读`);
  for (const p of cost.perStatement) console.log(`  ${p.rows_read} 行 ← ${oneLine(p.sql, 90)}`);
}

console.log("[计划]", explainPlan("SELECT * FROM match WHERE status = 'finished' ORDER BY id DESC LIMIT 5"));
