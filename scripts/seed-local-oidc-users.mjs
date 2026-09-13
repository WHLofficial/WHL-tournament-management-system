// 本地 OIDC 冒烟的固定用户（只打印 SQL，不直接执行；生产库绝不运行）：
//   SQL=$(node scripts/seed-local-oidc-users.mjs)
//   npx wrangler d1 execute whl --local --command "$SQL"        # tour 自己的本地库
//   cd ../WHL-auth-service && npx wrangler d1 execute whl --local --command "$SQL"
//   （auth 本地的 TOUR_DB 副本也要同 id 同名——auth 登录验密、签发 sub= user id 都查它）
// 密码统一 TestPass123；id 取 901+ 避开日常开发数据。
import { pbkdf2Sync, randomBytes } from "node:crypto";

function hash(pw) {
  const salt = randomBytes(16);
  // 格式与 worker/lib/crypto.ts 一致：pbkdf2$25000$salt_b64$hash_b64（两站互通的列）
  return `pbkdf2$25000$${salt.toString("base64")}$${pbkdf2Sync(pw, salt, 25000, 32, "sha256").toString("base64")}`;
}

const users = [
  // [id, name, role, locked]；901/902 给冒烟当 admin/coach 探针，903 当观众号探针
  [901, "oidctour-admin", "admin", 0],
  [902, "oidctour-coach", "coach", 0],
  [903, "oidctour-viewer", "coach", 1],
];

const rows = users
  .map(([id, name, role, locked]) => `(${id}, '${name}', '', '${hash("TestPass123")}', '${role}', ${locked}, 0)`)
  .join(", ");

// 单行输出：wrangler 的 --command 在 Windows 下多行实参会在换行处被截断
console.log(`UPDATE organization SET allow_open_reg = 1 WHERE id = 1; INSERT OR IGNORE INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES ${rows};`);
