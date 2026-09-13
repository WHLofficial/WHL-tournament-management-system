-- 统一认证迁移步骤②（auth 项目 PRD P0-7，tour 降级）：OIDC 本地会话。
-- tour_session cookie 只存随机 token，本表按 sha256(token) 建行；
-- sub 即 tour user id（账号真源此刻还在本库），姓名/角色每次现查 user 表，
-- 与兼容模式的 KV 会话行为等价（真源收口到 auth 库是迁移步骤③的事）。
CREATE TABLE oidc_session (
  token_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,             -- tour user id（步骤③收口后变为 auth 账号 id）
  auth_sid TEXT NOT NULL,        -- auth 登录会话指纹（ID token 的 sid；back-channel 登出按此吊销）
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_oidc_session_sid ON oidc_session (auth_sid);
