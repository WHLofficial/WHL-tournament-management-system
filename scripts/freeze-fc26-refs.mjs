// 一次性冻结脚本（B1 计划 S1）：从 club 仓真源生成 RoleID/PosID → 战术板槽位/位置码 的 TS 映射段。
// 产物打印到 stdout，人工核对后粘进 shared/roleFit.ts 冻结——之后 roleFit.ts 不联网、不依赖
// club 仓（与 shared/fc26Playstyles.ts 同一冻结哲学）；FC26 大版本换代时重跑一次重新冻结。
// 只读 club 仓 web/assets/ref/{role,position}.json，不写任何文件、不改 club 仓。
// 自检：覆盖表 49 行必须与 role.json 的 49 个「位置×角色中文名」恰好互吃、+/++ 档位与 id 段
// 交叉核对（id ≥ 101 必为 ++）、哨兵 142 = ST 禁区之王 ++ 对齐才算过。
// 用法：node scripts/freeze-fc26-refs.mjs
import { readFileSync } from "node:fs";

const CLUB_REF =
  "C:/Users/bhdjb/whlProgram/WHL-club-operations-platform/web/assets/ref";

// club role.json 的 chs 形如 "ST 突前前锋 ++" / "GK 出球型门将 +"：位置码 + 中文名 + 熟悉档。
const CHS_RE = /^([A-Z]{2,3}) (.+) (\+{1,2})$/;
const PTE26_POS = new Set([
  "GK",
  "RB",
  "LB",
  "CB",
  "CDM",
  "CM",
  "RM",
  "LM",
  "CAM",
  "RW",
  "LW",
  "ST",
]);

// 「角色中文名 → PTE26 角色码」49 行覆盖表（键 = "位置|club 中文名"）。
// 中文名对代码是歧义的，全部手工指定（计划 S1），易错的几行：
//   CDM 镇守→H 不是 CH（CH 是 FC26 的 Centre-Half，即 club 说的「中前卫」）、
//   CDM 中前卫→CH、CDM 半边卫→WH 不是 HW（半边锋才是 HW）、CDM 禁区冲击者→BC、
//   RB/LB 伪后卫→FAB（别混 ST 的伪九号 F9）、RM/LM 边中场→WM 不是 W。
const CODE_BY_NAME = {
  "GK|门将": "GK",
  "GK|清道夫门将": "SK",
  "GK|出球型门将": "BPK",
  "RB|边后卫": "FB",
  "RB|伪后卫": "FAB",
  "RB|边翼卫": "WB",
  "RB|进攻型边翼卫": "AWB",
  "RB|内切型边后卫": "IWB",
  "LB|边后卫": "FB",
  "LB|伪后卫": "FAB",
  "LB|边翼卫": "WB",
  "LB|进攻型边翼卫": "AWB",
  "LB|内切型边后卫": "IWB",
  "CB|后卫": "D",
  "CB|施压": "S",
  "CB|控球后卫": "BPD",
  "CB|边中卫": "WDB",
  "CDM|镇守": "H",
  "CDM|中前卫": "CH",
  "CDM|拖后组织核心": "DLP",
  "CDM|半边卫": "WH",
  "CDM|禁区冲击者": "BC",
  "CM|全能中场": "BTB",
  "CM|镇守": "H",
  "CM|拖后组织核心": "DLP",
  "CM|组织核心": "PL",
  "CM|半边锋": "HW",
  "RM|边锋": "W",
  "RM|边中场": "WM",
  "RM|边路组织核心": "WP",
  "RM|内锋": "IF",
  "LM|边锋": "W",
  "LM|边中场": "WM",
  "LM|边路组织核心": "WP",
  "LM|内锋": "IF",
  "CAM|组织核心": "PL",
  "CAM|影子前锋": "SS",
  "CAM|半边锋": "HW",
  "CAM|传统十号位": "C10",
  "RW|边锋": "W",
  "RW|内锋": "IF",
  "RW|边路组织核心": "WP",
  "LW|边锋": "W",
  "LW|内锋": "IF",
  "LW|边路组织核心": "WP",
  "ST|突前前锋": "AF",
  "ST|禁区之王": "PO",
  "ST|伪九号": "F9",
  "ST|站桩中锋": "TF",
};

const roles = JSON.parse(readFileSync(`${CLUB_REF}/role.json`, "utf8"));
const positions = JSON.parse(readFileSync(`${CLUB_REF}/position.json`, "utf8"));

const errors = [];
const byId = [];
const seenNames = new Set();
for (const r of roles) {
  if (r.id === 0) continue; // 0 = "-" 占位
  const m = r.chs.match(CHS_RE);
  if (!m) {
    errors.push(`chs 解析失败: id=${r.id} chs="${r.chs}"`);
    continue;
  }
  const [, pos, name, plus] = m;
  const tierFromSuffix = plus.length; // + → 1，++ → 2
  const tierFromId = r.id >= 101 ? 2 : 1;
  if (tierFromSuffix !== tierFromId)
    errors.push(`档位不一致: id=${r.id} chs="${r.chs}"（后缀 ${tierFromSuffix} 档 vs id 段 ${tierFromId} 档）`);
  if (!PTE26_POS.has(pos))
    errors.push(`未知位置码: "${pos}" (${r.chs})`);
  const key = `${pos}|${name}`;
  const code = CODE_BY_NAME[key];
  if (!code) errors.push(`覆盖表缺行: ${key}`);
  seenNames.add(key);
  byId.push({ id: r.id, slot: `${pos}|${code ?? "?"}`, tier: tierFromId });
}
const extra = Object.keys(CODE_BY_NAME).filter((k) => !seenNames.has(k));
if (extra.length) errors.push(`覆盖表多行（role.json 里没有）: ${extra.join(", ")}`);
if (seenNames.size !== 49) errors.push(`覆盖表只覆盖 ${seenNames.size}/49 个「位置×角色」`);
if (byId.length !== 98) errors.push(`role.json 解析出 ${byId.length}/98 条（应为 49 角色 × 2 档）`);
if (errors.length) {
  console.error([...errors].join("\n"));
  process.exit(1);
}

byId.sort((a, b) => a.id - b.id);
const roleLines = byId
  .map((r) => `  ${r.id}: { slot: "${r.slot}", tier: ${r.tier} },`)
  .join("\n");
const posLines = [...positions]
  .sort((a, b) => a.id - b.id)
  // 负数键必须是计算属性（TS/ES 的对象字面量不认裸 -1:），其余键原样
  .map((p) => `  ${p.id < 0 ? `[${p.id}]` : p.id}: "${p.name}",`)
  .join("\n");

console.log(`export const FC26_ROLE_BY_ID: Record<number, { slot: string; tier: 0 | 1 | 2 }> = {
${roleLines}
};

export const FC26_POS_BY_ID: Record<number, string> = {
${posLines}
};`);
console.error(`OK: 98 RoleID + ${positions.length} PosID，49 个「位置×角色」全覆盖。`);
