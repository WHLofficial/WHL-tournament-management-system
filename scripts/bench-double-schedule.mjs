// 双循环算法基准（spec §9.4）：node scripts/bench-double-schedule.mjs 直接跑，不入 CI。
// 输出 n=12/16/20 × 各 5 个 seed 的 balanced（hard=0）命中率、耗时、nonMirrorRounds；
// 预算目标：n=12 ≤5s、n=16 ≤10s、n=20 ≤15s 内尽量 hard=0。
//
// 为什么不直接 import：doubleSchedule.ts 是 TS 且内部相对导入不带扩展名（vite/tsc 习惯），
// Node 的 strip-types 解析不了（scripts/check-seeding.ts 的直跑方式实际会 ERR_MODULE_NOT_FOUND）。
// 这里用仓库现成的 esbuild（vite/vitest 依赖）把算法模块打成临时 bundle，动态 import 后跑基准，
// 结束即清理临时目录——保持 `node scripts/bench-double-schedule.mjs` 一条命令自包含可复现。
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "worker", "lib", "doubleSchedule.ts");

const tmp = mkdtempSync(join(tmpdir(), "bench-double-"));
let generateDouble;
try {
  const outfile = join(tmp, "doubleSchedule.mjs");
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  ({ generateDouble } = await import(pathToFileURL(outfile).href));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 各规模的预算（ms）与 seed（固定 5 个，结果可复现）
const CASES = [
  { n: 12, budgetMs: 5000 },
  { n: 16, budgetMs: 10000 },
  { n: 20, budgetMs: 15000 },
];
const SEEDS = [1, 2, 3, 4, 5];

for (const { n, budgetMs } of CASES) {
  const rows = [];
  for (const seed of SEEDS) {
    const r = generateDouble(n, { mode: "asymmetric", seed, budgetMs });
    rows.push({ seed, balanced: r.balanced, hard: r.hard, nm: r.nonMirrorRounds, ms: r.ms });
  }
  const hit = rows.filter((x) => x.balanced).length;
  const avgMs = Math.round(rows.reduce((s, x) => s + x.ms, 0) / rows.length);
  const maxMs = Math.max(...rows.map((x) => x.ms));
  console.log(`n=${n} budgetMs=${budgetMs}`);
  for (const x of rows) {
    console.log(
      `  seed ${x.seed}: balanced=${x.balanced} hard=${x.hard} nonMirrorRounds=${x.nm} ms=${x.ms}`
    );
  }
  console.log(
    `  → hard=0 命中率 ${hit}/${rows.length}；平均 ${avgMs}ms、最慢 ${maxMs}ms（预算 ${budgetMs}ms）`
  );
}
