// 通过 wrangler CLI 访问 D1（脚本里不引 D1 driver）。
//
// 只在 scripts/ 下的运维脚本里用；worker 运行时的查询走 env.DB，别引这个文件。

import { spawnSync } from "node:child_process";

const DB = "whl";

function quote(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

interface WranglerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function wrangler(args: string[]): WranglerResult {
  const cmd = ["npx", "wrangler", ...args].map(quote).join(" ");
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 查询：返回 results 数组。SQL 压成一行，避免 cmd.exe 把换行拆坏参数。 */
export function queryD1<T>(sql: string, remote: boolean): T[] {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const r = wrangler(["d1", "execute", DB, remote ? "--remote" : "--local", "--json", "--command", oneLine]);
  if (r.status !== 0) throw new Error(`D1 查询失败：${r.stderr.trim() || r.stdout.trim()}`);
  // wrangler 有时会在 JSON 前面打日志，从最后一个行首 "[" 开始截。
  const start = r.stdout.lastIndexOf("\n[");
  const json = JSON.parse(start >= 0 ? r.stdout.slice(start + 1) : r.stdout);
  return (json[0]?.results ?? []) as T[];
}

/** 执行 SQL 文件（多语句）。-y 跳过 --remote 的交互确认。 */
export function applySqlFile(file: string, remote: boolean): void {
  const r = wrangler(["d1", "execute", DB, remote ? "--remote" : "--local", "--file", file, "-y"]);
  if (r.status !== 0) throw new Error(`D1 执行失败：${r.stderr.trim() || r.stdout.trim()}`);
  process.stdout.write(r.stdout);
}

/** 执行单条/多条语句（分号分隔），返回 wrangler 输出。SQL 同样压成一行。 */
export function execD1(sql: string, remote: boolean): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const r = wrangler(["d1", "execute", DB, remote ? "--remote" : "--local", "--command", oneLine, "-y"]);
  if (r.status !== 0) throw new Error(`D1 执行失败：${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
