// 账号投影（本仓 user 表 = 认证中心 account 的精简投影）。
//
// 迁移步骤③收口（auth P0-10）把账号真源搬到 auth 库后，本仓 user 表就再无写入方
// （见 routes/admin/accounts.ts 顶部注释、v3.0.0 提交）。但外键还挂在它上面——生产库共
// 14 列引用 user(id)：tactic.created_by、tactic_submission.created_by、match_event.created_by、
// audit_log.actor_user_id、tournament.created_by、announcement.created_by、motm_vote.user_id、
// injury.created_by、team.created_by、signup_code.created_by、auth_code.used_by/created_by、
// identity.user_id、team_member.user_id。于是收口后新注册的账号一写就撞
// FOREIGN KEY constraint failed，未捕获时就是 500（2026-09-23 线上 15 连发即此）。
//
// 这里把 auth 账号投影回本地三列：id（两个 id 空间同值，见 authClient.ts 注释）、name、locked。
// password_hash 用哨兵、role 用占位——鉴权真源是会话里的 claims（session.ts 的 resolveOidcUser），
// 本表只供外键当靶子、以及几处 LEFT JOIN 取显示名。
import type { Bindings } from "../env";

/** 哨兵口令：lib/crypto.ts 的 verifyPassword 对非 `pbkdf2$轮数$盐$散列` 形态直接返回 false，
 *  因此这个值永远验不过（改动前先看一眼 verifyPassword 的格式判定） */
export const MIRROR_PASSWORD = "!oidc-no-password";

export interface MirrorAccount {
  id: number;
  name: string;
  locked: boolean;
  /** auth account.created_at；登录路径只能拿登录时刻凑，由定时对账改回真实注册时间 */
  createdAt: string;
}

/** 投影一条账号。id 冲突则同步 name/locked/created_at；role 与 password_hash 绝不进 updater：
 *  role 跟着 auth 走就等于制造第二个角色真源，password_hash 跟着走就等于本地能自证身份。 */
export function mirrorAccountStmt(db: D1Database, a: MirrorAccount): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO user (id, name, password_hash, role, locked, created_at)
       VALUES (?, ?, ?, 'coach', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, locked = excluded.locked, created_at = excluded.created_at`,
    )
    .bind(a.id, a.name, MIRROR_PASSWORD, a.locked ? 1 : 0, a.createdAt);
}

/** 定时对账：登录回调只覆盖「新登录」，存量会话、以及建了账号却还没登录过的人靠这里补齐。
 *  只补不删——本表是外键靶子，删行会连累历史数据。失败只记日志，不把一次抖动记成 cron 失败。 */
export async function runAccountMirror(env: Bindings): Promise<void> {
  if (!env.AUTH_DB) {
    console.log("[mirror-accounts] 未配置 AUTH_DB，跳过");
    return;
  }
  try {
    const remote = await env.AUTH_DB.prepare(
      "SELECT id, name, locked, created_at FROM account ORDER BY id",
    ).all<{ id: number; name: string; locked: number; created_at: string }>();
    const accounts = remote.results ?? [];
    const local = await env.DB.prepare("SELECT id, name FROM user").all<{ id: number; name: string }>();
    const have = new Map((local.results ?? []).map((r) => [r.id, r.name]));

    const pending = accounts.filter((a) => have.get(a.id) !== a.name);
    if (!pending.length) {
      console.log(`[mirror-accounts] 账号 ${accounts.length} 条，无缺行/改名`);
      return;
    }
    await env.DB.batch(
      pending.map((a) =>
        mirrorAccountStmt(env.DB, {
          id: a.id,
          name: a.name,
          locked: a.locked === 1,
          createdAt: a.created_at,
        }),
      ),
    );
    const added = pending.filter((a) => !have.has(a.id)).map((a) => a.id);
    const renamed = pending.filter((a) => have.has(a.id)).map((a) => a.id);
    console.log(
      `[mirror-accounts] 账号 ${accounts.length} 条：补行 ${added.length}${added.length ? `（${added.join(",")}）` : ""}` +
        `、同步改名 ${renamed.length}${renamed.length ? `（${renamed.join(",")}）` : ""}`,
    );
  } catch (e) {
    console.error(`[mirror-accounts] 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
