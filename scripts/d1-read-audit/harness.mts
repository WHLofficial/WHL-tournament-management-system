/**
 * D1 读消耗度量基建（增量 38）
 *
 * 手法：用「假 D1」抓住真实路由发出的 SQL 与绑定参数 → 参数内联成字面量 →
 *       经 wrangler 管理通道把该 SQL 打到生产库，读回 `meta.rows_read`。
 *       D1 按**扫描行数**计费（索引扫描同样计入），所以这个读数就是配额消耗的物理事实。
 * 用 vite-node 跑（本仓 worker 源码是无后缀 import，Node 原生类型剥离解析不了）：
 *       npx vite-node scripts/d1-read-audit/measure-surface.mts
 *
 * 三条边界（报告里必须一起交代）：
 *  1) 走的是**管理通道**（wrangler d1 execute --remote --file），不是 worker 运行时通道。
 *     SQL 形状与数据一致 ⇒ 读数一致；但不含运行时网络/CPU，也不含 D1 每 Worker 调用 50 查询的软上限约束。
 *  2) 假 D1 回的是**桩数据**。路由内分支若依赖真实行内容（存在与否、某枚举值），
 *     抓到的可能是与线上不同的分支 ⇒ 读数偏差登记在册（每个读面单独登记）。
 *  3) 读数含索引扫描行数，这是 D1 的计费口径，不等于「返回给应用的行数」。
 *  4) 参数内联后 SQL 会经 Cloudflare 上传执行（仅 SELECT）；禁止把会话令牌、口令哈希等
 *     真实敏感值内联进来 —— 探针一律用假值。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ─────────────────────────── SQL 文本处理 ─────────────────────────── */

/** 把 JS 值变成 SQL 字面量。`%` 一律换成 char(37)：Windows 上命令要过 cmd.exe，`%x%` 会被当变量展开。 */
export function quoteLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`不能内联非有限数：${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "bigint") return String(v);
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''").replace(/%/g, "'||char(37)||'")}'`;
}

/**
 * 把 `?` 占位符换成字面量。手写扫描器而不是正则 —— 必须跳过字符串字面量内部的 `?`。
 * 绑定参数个数与占位符个数不符即抛错（宁可炸掉也不静默测错形状）。
 */
export function inlineParams(sql: string, args: unknown[] = []): string {
  let out = "";
  let arg = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i]!;
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") out += sql[i++]!;
      continue;
    }
    if (ch === "?") {
      if (arg >= args.length) throw new Error(`占位符多于绑定参数：\n${sql}`);
      out += quoteLiteral(args[arg++]);
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (arg !== args.length) {
    throw new Error(`绑定参数多于占位符（${arg}/${args.length}）：\n${sql}`);
  }
  return out;
}

export interface Captured {
  sql: string;
  args: unknown[];
  db: "DB" | "AUTH_DB";
  /** 该语句被执行了几次（同一次请求内循环绑定算多次，读量按次数累计）。 */
  calls: number;
  /** 实放模式（mode:"live"）下该次执行的物理行读；桩行模式为 0。 */
  rows_read?: number;
  /** 实放模式下回传的结果行数。 */
  result_rows?: number;
}

/**
 * 只放行纯读语句。GET 里也可能藏写（延迟结算、自动重算），
 * 度量通道绝不能把写语句打到生产。
 */
export function selectOnly(statements: Captured[]): { keep: Captured[]; skipped: Captured[] } {
  const keep: Captured[] = [];
  const skipped: Captured[] = [];
  for (const s of statements) {
    const head = s.sql.trim().replace(/^\(+/, "");
    const isSelect = /^SELECT\b/i.test(head);
    const isReadWith =
      /^WITH\b/i.test(head) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(head);
    (isSelect || isReadWith ? keep : skipped).push(s);
  }
  return { keep, skipped };
}

/* ─────────────────────────── 管理通道 ─────────────────────────── */

export interface ReadCost {
  rows_read: number;
  rows_written: number;
  queries: number;
  duration_ms: number;
}

let tmpDir: string | null = null;
function scriptDir(): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), "d1-read-audit-"));
  return tmpDir;
}

/**
 * 直接跑 wrangler 的 JS 入口，不经 `npx` + shell。
 * 走过 shell 的教训：`shell: true` 下 Node 不替参数加引号，含空格的 SQL 会被 cmd.exe 拆成
 * 一堆「Unknown arguments: SELECT, *, FROM, match …」；而 `npx` 又是 `.cmd`，不加 shell 又起不来。
 * 绕开两者：node + `node_modules/wrangler/bin/wrangler.js`，参数原样传递。
 */
function wranglerJs(): string {
  const candidates = [
    join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js"),
    join(import.meta.dirname, "..", "..", "node_modules", "wrangler", "bin", "wrangler.js"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`找不到 wrangler 入口，尝试过：\n${candidates.join("\n")}`);
}

function runCli(args: string[]): string {
  try {
    return execFileSync(process.execPath, [wranglerJs(), "d1", "execute", ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });
  } catch (e) {
    // execFileSync 默认的报错信息只有命令行（SQL 很长时完全看不出原因），真正的错在 stderr 里。
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const detail = String(err.stderr ?? "").trim() || String(err.stdout ?? "").trim() || err.message || "";
    throw new Error(`wrangler 执行失败：${detail.slice(0, 600)}`);
  }
}

/** 从 wrangler 的 stdout 里切出 JSON 数组（前面有 "Checking if file needs uploading" 之类的横幅）。 */
function parseJsonArray(out: string): Array<{
  results?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
}> {
  const start = out.indexOf("[");
  if (start < 0) {
    const head = out.indexOf("{");
    if (head >= 0) {
      const err = JSON.parse(out.slice(head)) as { error?: { text?: string } };
      throw new Error(`wrangler 报错：${err.error?.text ?? out.slice(head, head + 400)}`);
    }
    throw new Error(`wrangler 输出无法解析：\n${out.slice(-800)}`);
  }
  return JSON.parse(out.slice(start));
}

/**
 * 把 SQL（可多语句）打到生产库并读回行读量。
 * 用 --file 而不是 --command：SQL 走临时文件，彻底绕开 Windows cmd.exe 的 `%` 展开与引号转义。
 */
export function runWrangler(
  sql: string,
  opts: { db?: string; remote?: boolean; attempts?: number } = {},
): ReadCost {
  const { db = "whl", remote = true, attempts = 3 } = opts;
  const file = join(scriptDir(), `stmt-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(file, sql.trim().replace(/;?\s*$/, "") + ";\n", "utf8");
  try {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = runCli([db, remote ? "--remote" : "--local", "--json", `--file=${file}`]);
        const data = parseJsonArray(out);
        const meta = data[0]?.meta ?? {};
        const summary = data[0]?.results?.[0] ?? {};
        const numOf = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
        return {
          rows_read: numOf(meta.rows_read ?? summary["Rows read"]),
          rows_written: numOf(meta.rows_written ?? summary["Rows written"]),
          queries: numOf(summary["Total queries executed"]) || 1,
          duration_ms: numOf(meta.duration),
        };
      } catch (e) {
        lastErr = e;
        // 已知 Windows 偶发退出码 3221226505 / libuv 断言，重跑即过。
      }
    }
    throw lastErr;
  } finally {
    rmSync(file, { force: true });
  }
}

/** 查询执行计划，用来证明两条形状真的走了不同路径。 */
export function explainPlan(sql: string, opts: { db?: string } = {}): string[] {
  const rows = queryRows(`EXPLAIN QUERY PLAN ${sql}`, opts);
  return rows.map((r) => String(r.detail ?? r.DETAIL ?? JSON.stringify(r)));
}

/** 管理通道取某库近 24h 用量（`wrangler d1 info`）——不消耗行读，用来记录账号侧基线。 */
export function d1Info(name: string): Record<string, unknown> {
  const out = execFileSync(process.execPath, [wranglerJs(), "d1", "info", name, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`d1 info 输出无法解析：\n${out.slice(-500)}`);
  return JSON.parse(out.slice(start)) as Record<string, unknown>;
}

/**
 * 读回真实行（例如取线上 id 让探针 URL 立体）、以及取 EXPLAIN 输出。
 *
 * 必须走 `--command`：实测 `--file` 只回一条聚合汇总行（`{"Total queries executed":n,"Rows read":m}`），
 * 不回具体数据行；`--command` 才回 results。两个通道的 `meta.rows_read` 都准（行读量用它取）。
 * 注意 `--command` 里 SQL 不能含 `%`（Windows 上要过 cmd.exe），故 `1 LIKE '%x%'` 一律先写成 char(37)。
 */
/**
 * 用 `--command` 打生产并回传 meta（含 rows_read）与结果行数。
 * 与 runWrangler（`--file`）是两个不同的 wrangler 执行通道，同一 SQL 的读数口径未必一致，
 * 成本模型的关键结论必须两条通道各量一遍再下判断。
 */
export function queryMeta(
  sql: string,
  opts: { db?: string; attempts?: number } = {},
): { rows: number; rows_read: number; rows_written: number } {
  const { db = "whl", attempts = 3 } = opts;
  const cmd = sql.trim().replace(/;?\s*$/, "");
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = runCli([db, "--remote", "--json", "--command", cmd]);
      const data = parseJsonArray(out) as Array<{ results?: unknown[]; meta?: { rows_read?: number; rows_written?: number } }>;
      const first = data[0];
      return {
        rows: first?.results?.length ?? 0,
        rows_read: first?.meta?.rows_read ?? -1,
        rows_written: first?.meta?.rows_written ?? 0,
      };
    } catch (e) {
      // 管理通道偶发失败（Windows 退出码 3221226505 / Cloudflare API 限流），重跑即过。
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * 实放模式：把带参 SQL 内联成字面量后打到生产，**回传真实数据行**与行读量。
 * 与桩行模式的差别在于「扇出次数」——桩 D1 的 all() 恒回 1 行，per-row/per-stage 的循环
 * 只会跑一次，于是 LIMIT 45 的窗口、11 条轮次综述在探针里都被压成 1 次；
 * 实放模式让应用用真实数据跑真实扇出，量到的才是线上形状。
 * 只读：调用方负责先用 selectOnly 过滤掉写语句。
 */
export function runQueryLive(
  sql: string,
  args: unknown[],
  opts: { db?: string; attempts?: number } = {},
): { rows: Array<Record<string, unknown>>; rows_read: number; rows_written: number } {
  const { db = "whl", attempts = 3 } = opts;
  const cmd = inlineParams(sql, args).trim().replace(/;?\s*$/, "");
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = runCli([db, "--remote", "--json", "--command", cmd]);
      const data = parseJsonArray(out) as Array<{
        results?: Array<Record<string, unknown>>;
        meta?: { rows_read?: number; rows_written?: number };
      }>;
      const first = data[0];
      return {
        rows: first?.results ?? [],
        rows_read: first?.meta?.rows_read ?? -1,
        rows_written: first?.meta?.rows_written ?? 0,
      };
    } catch (e) {
      // 管理通道偶发失败（Windows 退出码 3221226505 / Cloudflare API 限流），重跑即过。
      lastErr = e;
    }
  }
  throw lastErr;
}

export function queryRows(sql: string, opts: { db?: string; attempts?: number } = {}): Array<Record<string, unknown>> {
  const { db = "whl", attempts = 3 } = opts;
  const cmd = sql.trim().replace(/;?\s*$/, "");
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = runCli([db, "--remote", "--json", "--command", cmd]);
      const data = parseJsonArray(out);
      return data[0]?.results ?? [];
    } catch (e) {
      lastErr = e;
      // 管理通道偶发失败（Windows 退出码 3221226505 / Cloudflare API 限流），重跑即过。
    }
  }
  throw lastErr;
}

/* ─────────────────────────── 假 D1 ─────────────────────────── */

/** 数值型列名：桩行里给 1，避免 `Number(row.id)` 变 NaN 导致下游分支跑偏。 */
const NUMERIC_KEY = /^(id|[a-z_]*_id|ok|n|cnt|count|total|rank|round|score|goals|home|away|number|seq|revision|is_[a-z_]+|has_[a-z_]+)$/;
/** 字符串型列名：桩行里给占位串，避免 `row.name.length` 之类崩掉。 */
const TEXT_KEY = /(name|title|status|state|type|format|text|venue|key|value|sub|code|hash|url|slug|remark|note)$/;
/**
 * 合同关键列必须回「能继续走数据路径」的值：战报/轮次综述的守卫是
 * `if (!m || m.status !== "finished") return null`，桩行回 "probe" 会让它们直接 404，
 * 于是量不到这些读面的真实 SQL 形状。
 */
const VALUE_HINT: Record<string, string | number> = { status: "finished" };

/**
 * 覆盖桩行里关键列的值。写端点的状态前置校验彼此冲突（开赛要求 `pending`、
 * 录事件要求非 `pending`、赛事状态机 ALLOWED 只认 draft/registering/running/archived），
 * 一律回 "finished" 会让它们在前置守卫处 400/500 提前退出，量不到后面的 SQL。
 * 有些守卫是数值比较（`row.home_tid !== teamId`），所以值允许给数字。
 * 每次 captureSurface 前调用即可，不传则回到默认。
 */
export function setValueHints(hints: Record<string, string | number> = {}): void {
  for (const k of Object.keys(VALUE_HINT)) delete VALUE_HINT[k];
  VALUE_HINT.status = "finished";
  Object.assign(VALUE_HINT, hints);
}

function benignRow(db: "DB" | "AUTH_DB") {
  const row: Record<string, unknown> = {};
  return new Proxy(row, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      if (prop === "claims") return JSON.stringify(PROBE_CLAIMS);
      if (prop === "sub") return "1";
      if (VALUE_HINT[prop] !== undefined) return VALUE_HINT[prop];
      if (NUMERIC_KEY.test(prop)) return 1;
      if (TEXT_KEY.test(prop)) return "probe";
      if (prop === "claims") return JSON.stringify(PROBE_CLAIMS);
      if (prop === "sub") return "1";
      if (db === "AUTH_DB" && /password/i.test(prop)) return "!probe";
      return null;
    },
    has: () => true,
  });
}

interface Stmt {
  __captured: Captured;
  bind(...args: unknown[]): Stmt;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
  run(): Promise<{ success: true; meta: Record<string, unknown> }>;
}

/**
 * 记录型 D1：prepare 记账、执行时把 {sql,args} 推进 sink。
 * `rows` 模式下 all() 回一行桩数据（生产表里有数据，回空会让路由提前 return 而漏测后续查询；
 * 偏大计是配额治理的安全方向）；`empty` 模式回空数组，用于对照「空库路径」。
 * `live` 模式把语句实放打生产、回真实数据行并记下 meta.rows_read —— 用它量真实扇出次数
 * （桩行模式每查恒回 1 行，per-row 循环只会跑一次，会把 feed 这类扇出型读面严重低估）。
 * 写语句在 live 模式下也只记账不执行（度量通道绝不写生产）。
 */
export function makeCaptureDb(
  sink: Captured[],
  opts: { db?: "DB" | "AUTH_DB"; mode?: "rows" | "empty" | "live" } = {},
) {
  const dbTag = opts.db ?? "DB";
  const mode = opts.mode ?? "rows";
  const live = mode === "live";
  const dbName = dbTag === "AUTH_DB" ? "whl-auth" : "whl";

  const makeStmt = (sql: string, args: unknown[]): Stmt => {
    const rec = (extra: Partial<Captured> = {}) =>
      sink.push({ sql, args, db: dbTag, calls: 1, ...extra });
    const isWrite = !/^\s*(SELECT|WITH)\b/i.test(sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
    const runLive = () => runQueryLive(sql, args, { db: dbName });
    return {
      __captured: { sql, args, db: dbTag, calls: 0 },
      bind(...next: unknown[]) {
        return makeStmt(sql, next);
      },
      async first<T>() {
        const flat = sql.replace(/\s+/g, " ");
        // 探针会话：生产库里没有 probe-token 的 token_hash，实放会查空 ⇒ 恒用桩 claims。
        if (/FROM oidc_session/i.test(flat)) {
          rec();
          return { ok: 1, sub: "1", claims: JSON.stringify(PROBE_CLAIMS) } as T;
        }
        if (live && !isWrite) {
          const r = runLive();
          rec({ rows_read: r.rows_read, result_rows: r.rows.length });
          return (r.rows[0] ?? null) as T | null;
        }
        rec();
        return benignRow(dbTag) as T;
      },
      async all<T>() {
        if (live && !isWrite) {
          const r = runLive();
          rec({ rows_read: r.rows_read, result_rows: r.rows.length });
          return { results: r.rows as T[], success: true as const, meta: { rows_read: r.rows_read, rows_written: 0 } };
        }
        rec();
        const results = (mode === "empty" ? [] : [benignRow(dbTag)]) as T[];
        return { results, success: true as const, meta: { rows_read: 0, rows_written: 0 } };
      },
      async run() {
        rec();
        return { success: true as const, meta: { rows_read: 0, rows_written: 0 } };
      },
    };
  };

  return {
    prepare: (sql: string) => makeStmt(sql, []),
    async batch(stmts: Stmt[]) {
      return Promise.all(stmts.map((s) => s.all()));
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
  };
}

/** 探针会话：必须是超管 + 本仓全部 4 个权限点，否则管理端路由会在 requirePermission 处提前退出。 */
export const PROBE_CLAIMS = {
  name: "探针",
  locked: false,
  must_change_pw: false,
  roles: ["superadmin"],
  permissions: [
    "tour.accounts.manage",
    "tour.match.manage",
    "tour.org.settings",
    "tour.team.bind",
  ],
};

/** 带 TTL/写入的假 KV：默认空（冷路径），写入后同进程内可读（热路径）。 */
export function makeFakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (type === "json") return JSON.parse(raw);
      return raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cursor: "" };
    },
    __store: store,
  };
}

/** caches.default 的进程内替身：默认永不命中 ⇒ 量到的是**冷缓存**读数（保守）。 */
export function installCachesStub() {
  const g = globalThis as unknown as { caches?: { default: unknown } };
  if (!g.caches) {
    g.caches = {
      default: {
        async match() {
          return undefined;
        },
        async put() {},
        async delete() {
          return false;
        },
      },
    };
  }
}

export interface CaptureEnvOptions {
  db?: "DB" | "AUTH_DB";
  mode?: "rows" | "empty" | "live";
}

export function makeFakeEnv(sink: Captured[], opts: CaptureEnvOptions = {}) {
  installCachesStub();
  const mk = (tag: "DB" | "AUTH_DB") => makeCaptureDb(sink, { db: tag, mode: opts.mode });
  return {
    DB: mk("DB"),
    AUTH_DB: mk("AUTH_DB"),
    KV: makeFakeKv(),
    MEDIA: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    },
    ASSETS: {
      async fetch() {
        return new Response("", { status: 404 });
      },
    },
    AUTH_MODE: "oidc",
    OIDC_ISSUER: "https://auth.whleague.win",
    OIDC_CLIENT_ID: "tour",
    OIDC_REDIRECT_ORIGIN: "https://tour.whleague.win",
    CLUB_API_BASE: "https://club.whleague.win",
    TEAM_SYNC_SECRET: "probe-secret",
    AUTH_BIND_SECRET: "probe-secret",
    COOKIE_DOMAIN: "whleague.win",
  };
}

/* ─────────────────────────── 读面抓取 ─────────────────────────── */

export interface SurfaceResult {
  status: number;
  statements: Captured[];
  error?: string;
}

/** 带探针会话的请求头。公开面不需要，管理面必须带。 */
export function probeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: "__Host-tour_session=probe-token", ...extra };
}

/**
 * 直调真实 Hono 应用（worker/index.ts 默认导出已挂好全部路由），抓住它发出的 SQL。
 * 不手抄 SQL —— 路由改了，重跑就是新形状。
 *
 * app.request 的第 4 个参数（ExecutionContext）必须给：`pubCache` 与 media 路由都会
 * `c.executionCtx.waitUntil(cache.put(...))`，Hono 不给默认值，直接抛
 * `Error: This context has no ExecutionContext`（路由体已经跑完，但响应变 500）。
 */
export async function captureSurface(
  app: {
    request: (input: string, init?: RequestInit, env?: unknown, ctx?: unknown) => Promise<Response>;
  },
  url: string,
  init: RequestInit = {},
  opts: CaptureEnvOptions = {},
): Promise<SurfaceResult> {
  const sink: Captured[] = [];
  const env = makeFakeEnv(sink, opts);
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      promise.catch(() => {});
    },
    passThroughOnException() {},
  };
  try {
    const res = await app.request(url, init, env, executionCtx);
    return { status: res.status, statements: sink };
  } catch (e) {
    return { status: -1, statements: sink, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** 把一次抓取的结果打到生产，逐条语句给出行读量。 */
/**
 * 逐条语句打生产读 rows_read，×calls 得该语句总读。
 *
 * 用 `--command` 而不是 `--file`：两条通道对 join 类查询读数一致（差 1–24%），
 * 但 `--file` 对「单表索引扫描」会把 149 行报成 1 行，口径不可用。
 * 见 cost-model.json 的双通道阶梯。
 */
export function costOf(
  statements: Captured[],
  opts: { db?: string } = {},
): { perStatement: Array<{ sql: string; calls: number; rows_read: number }>; total: number } {
  const perStatement: Array<{ sql: string; calls: number; rows_read: number }> = [];
  let total = 0;
  for (const s of statements) {
    const sql = inlineParams(s.sql, s.args);
    const cost = queryMeta(sql, { db: s.db === "AUTH_DB" ? "whl-auth" : opts.db ?? "whl" });
    const rows = cost.rows_read * Math.max(1, s.calls);
    perStatement.push({ sql, calls: s.calls, rows_read: rows });
    total += rows;
  }
  return { perStatement, total };
}

/** 折成一行，便于报告与日志。 */
export function oneLine(sql: string, max = 110): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
