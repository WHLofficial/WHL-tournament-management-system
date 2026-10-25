-- v5.9.0：管理台调用 auth /api/admin/* 需要两把凭证——服务密钥 AUTH_ADMIN_SECRET（HMAC）
-- 和当前管理员的 access token（auth 校验用户身份、MFA 与权限点）。登录回调把 token 存进
-- 本地会话行；access token 过期时用 refresh token 换新，避免管理台 30 分钟后集体 401。
ALTER TABLE oidc_session ADD COLUMN access_token TEXT;
ALTER TABLE oidc_session ADD COLUMN access_expires_at TEXT;
ALTER TABLE oidc_session ADD COLUMN refresh_token TEXT;
