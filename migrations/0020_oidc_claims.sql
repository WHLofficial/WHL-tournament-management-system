-- 统一认证步骤③收口（auth 项目 P0-10/P0-11，TECH_DESIGN §6.3）：本地会话存 userinfo 下发的
-- claims（姓名/锁定/待改密/角色/权限），会话解析不再查本库 user 表——账号真源已在 auth 库，
-- 收口后新账号在本库无行。role 列已停写：user_role 授权的投影随 claims 下发。
-- 旧会话行 claims 为 NULL → 视为未登录，重新走一次 OIDC 登录即恢复（一次性重登成本）。
ALTER TABLE oidc_session ADD COLUMN claims TEXT;
