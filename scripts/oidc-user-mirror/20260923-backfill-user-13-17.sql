-- 一次性数据修复：认证中心已存在、但本仓 user 表缺行的账号补进来
--
-- 背景（2026-09-23 排查）：账号真源收口到认证中心后（v2.0.0 / v3.0.0D，commit c69b8ee「user 表自此代码零写入」），
-- 新注册账号不再在本仓 user 表留行。而 migrations/0009_tactics.sql:6/20 的 tactic.created_by、
-- tactic_submission.created_by 与 migrations/0015_interact.sql:8 的 motm_vote.user_id 都是
-- REFERENCES user(id)，D1 强制外键（PRAGMA foreign_keys = 1），于是这些账号的任何写入都
-- 直接 «FOREIGN KEY constraint failed» → 未捕获 → 500。
--
-- 实测证据：以 created_by = 14 插 tactic 报 SQLITE_CONSTRAINT_FOREIGNKEY；补行后同样的插入通过。
--
-- 本仓 user.id 与 auth account.id 命名空间一致：id 1–12 的 name 与 created_at 与 auth account 逐条相同。
-- 所以补行时沿用 auth account 的 id / name / created_at / locked，保持两侧对齐。
--
-- password_hash 用哨兵值：verifyPassword（worker/lib/crypto.ts:38）对非 "pbkdf2$iter$salt$hash"
-- 形态的串返回 false 而不抛错，即永远登不进去，方向是失败关闭。OIDC 模式下本列本就不参与鉴权
-- （worker/lib/session.ts resolveOidcUser 只取 JWT claims，不查 user 表）。
--
-- 执行：npx wrangler d1 execute whl --remote --file=scripts/oidc-user-mirror/20260923-backfill-user-13-17.sql
-- 幂等：ON CONFLICT(id) DO NOTHING，重复执行无副作用。

INSERT INTO user (id, name, email, password_hash, role, created_at, locked, must_change_pw) VALUES
  (13, 'TiAmo',    NULL, '!oidc-no-password', 'coach', '2026-09-21T07:34:59.255Z', 0, 0),
  (14, '雷雷雷',   NULL, '!oidc-no-password', 'coach', '2026-09-23T04:51:08.525Z', 0, 0),
  (15, 'Ryan',     NULL, '!oidc-no-password', 'coach', '2026-09-23T04:51:46.269Z', 0, 0),
  (16, 'WH_test',  NULL, '!oidc-no-password', 'coach', '2026-09-23T04:53:12.228Z', 1, 0),
  (17, 'WH_test2', NULL, '!oidc-no-password', 'coach', '2026-09-23T04:54:12.708Z', 0, 0)
ON CONFLICT(id) DO NOTHING;

-- 核对：应列出 13–17 五行，且 1–12 不受影响
SELECT id, name, role, locked, created_at FROM user WHERE id >= 13 ORDER BY id;
