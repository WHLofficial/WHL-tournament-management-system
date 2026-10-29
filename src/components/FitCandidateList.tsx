// FIT 适配度候选面板（B1 计划 S6 / spec §5.2）：球员卡「球员」select 下方的排序列表。
// select 保留不动（快速选人 + 触屏原生体验），这里把「谁适配这个角色」摆到决策现场：
// 行首 mono 大号 = 绝对分 rankShown（「和联盟比」，排序用它），点行展开构成明细，不黑箱。
// 视觉复用 asg- 系（属性 pill / 金银徽章 chip / 无数据胶囊 / 状态后缀），不引入新色板（spec §5）。
import { useState } from "react";
import { ASSIGN_ATTR_LABELS, roleFull } from "../../shared/tactics";
import { getPlaystyle } from "../../shared/fc26Playstyles";
import { ROLE_FIT } from "../../shared/roleFit";
import { ownRoleTag, playerOwnRoles } from "../../shared/playerRoles";
import { fitTile, type FitGroup, type FitProfile, type FitSlotScore } from "../../shared/fitScore";
import type { PlayerMeta } from "../../shared/types";

/** 候选行的球员形状（战术页 teamPlayers 的子集） */
export interface FitCandidatePlayer {
  id: number;
  name: string;
  number: string | null;
  meta?: PlayerMeta;
}

/** FIT 属性键 → 中文短名（pill 与展开贡献条用）。与 ASSIGN_ATTR_LABELS 重合的键直接引用
 *  同一份，防两处口径漂移；gkreflexes 取「门线反应」与场上 reactions（反应）区分。 */
const FIT_ATTR_LABELS: Record<string, string> = {
  ...ASSIGN_ATTR_LABELS,
  acceleration: "加速",
  agility: "敏捷",
  balance: "平衡",
  ballcontrol: "控球",
  composure: "沉着",
  crossing: "传中",
  dribbling: "盘带",
  gkdiving: "扑救",
  gkhandling: "手型",
  gkkicking: "开球",
  gkpositioning: "站位",
  gkreflexes: "门线反应",
  interceptions: "拦截",
  longpassing: "长传",
  positioning: "跑位",
  reactions: "反应",
  shortpassing: "短传",
  shotpower: "射门力量",
  sprintspeed: "冲刺",
  stamina: "体力",
  standingtackle: "抢断",
  vision: "视野",
};

// 磁贴底衬档位阈值（个人内契合分，spec §5.1 定稿：前 ~15% 绿、后一半红橙；S8 测试钉边界）
const FIT_TILE_GREEN = 85;
const FIT_TILE_YELLOW = 50;

/** fitTile → 磁贴底衬 class 四态（挂在 .tac-tile-role 上，色值见 styles.css 同名规则） */
export function fitTileClass(tile: number | null | undefined): string {
  if (tile == null) return "fit-na";
  if (tile >= FIT_TILE_GREEN) return "fit-g";
  if (tile >= FIT_TILE_YELLOW) return "fit-y";
  return "fit-o";
}

/** 球衣号排序键：空号 / 非数字排最后（口径同 lib/assignCandidates 的 jerseyOrder） */
function jerseyNum(number: string | null): number {
  const text = (number ?? "").trim();
  if (!text) return Number.POSITIVE_INFINITY;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * 候选排序：rankRaw 降序（未截断原始值——封顶只压显示不压排序，spec §4.2 ②）→ 球衣号升序
 * → 原序兜底；无数据（rankRaw null）恒排尾。纯函数，面板与 S8 单测共用同一口径。
 */
export function sortFitCandidates<T>(
  players: readonly T[],
  rankRawOf: (p: T) => number | null,
  jerseyOf: (p: T) => number,
): T[] {
  return players
    .map((p, index) => ({ p, index, rank: rankRawOf(p), jersey: jerseyOf(p) }))
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return a.jersey - b.jersey || a.index - b.index;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return b.rank - a.rank || a.jersey - b.jersey || a.index - b.index;
    })
    .map((x) => x.p);
}

interface FitRow {
  player: FitCandidatePlayer;
  /** 该槽位得分；null = 无 meta 或该角色关键属性键全缺（缺数据是事实，不是 0 分） */
  score: FitSlotScore | null;
  /** 个人内契合分（展开明细用；与行首绝对分各归其位，spec §4.2 ①②）。null = 无 meta /
   *  槽位缺键 / 场上球员的 GK 族槽（fitTile 无档；门将群外场槽位记 0，不再返回 null） */
  tile: number | null;
  suffix: string;
  elsewhere: string[];
}

export function FitCandidateList({
  players,
  slotKey,
  role,
  focus,
  heat,
  fitOfPid,
  groupOfPid,
  currentPid,
  elsewhereOf,
  suffixOf,
  onPick,
}: {
  players: readonly FitCandidatePlayer[];
  /** 槽位键（"ST|AF"，与 ROLE_FIT / fitProfileAll 同键） */
  slotKey: string;
  role: string;
  focus: string;
  /** 该槽位 5×5 热区（调用方已按左右侧算好）。热区是槽位属性、与球员无关，放头部一次不进每行 */
  heat: readonly number[] | null;
  fitOfPid: ReadonlyMap<number, FitProfile | null>;
  /** 位置群表（磁贴 fitGroupPid 直传，与 fitOfPid 同源同优先级）：fitTile 跨群无档的判定输入 */
  groupOfPid: ReadonlyMap<number, FitGroup>;
  currentPid: number | null;
  /** 这名球员在其他首发槽的位置码（当前查看槽除外）→「已首发」标记，仍可点（dup 口径与现状一致） */
  elsewhereOf: (playerId: number) => string[];
  suffixOf?: (playerId: number) => string;
  onPick: (playerId: number) => void;
}) {
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const prof = ROLE_FIT[slotKey] ?? null;
  // 权重前三属性 pill（spec §5.2：每行只显示该角色相关属性，不堆全量）
  const topAttrs = (prof?.attrs ?? []).slice(0, 3);

  const rows: FitRow[] = sortFitCandidates(
    players,
    (p) => fitOfPid.get(p.id)?.get(slotKey)?.rankRaw ?? null,
    (p) => jerseyNum(p.number),
  ).map((p) => {
    const profile = fitOfPid.get(p.id) ?? null;
    return {
      player: p,
      score: profile?.get(slotKey) ?? null,
      // 门将的场上槽位 fitTile 记 0（2026-10-29 口径，明细显 0 不再显「无」）；场上球员的
      // GK 族槽仍为 null → 明细显「无」、磁贴灰虚线。group 必须与磁贴同源（groupOfPid，
      // DTO meta 优先），不能用行内 p.meta 自判——否则「名册 meta 缺、DTO meta 带 GK PosID」
      // 的窗口里，同一人磁贴灰虚线、面板明细却出档
      tile: fitTile(profile, slotKey, groupOfPid.get(p.id) ?? "OUT"),
      suffix: suffixOf?.(p.id) ?? "",
      elsewhere: elsewhereOf(p.id),
    };
  });

  return (
    <div className="tac-fit">
      <div className="tac-fit-head">
        {/* 「FIT 适配度」兼作行首分数列的列头（spec §5.1：精确数字只在此处/明细/悬停出现） */}
        <p className="tac-fit-title">
          FIT 适配度 · {roleFull(role)}({focus})
        </p>
        <span className="tac-fit-heat" aria-hidden="true">
          {Array.from({ length: heat?.length ?? 25 }, (_, i) => {
            const lv = heat?.[i] ?? 0;
            return <i key={i} className={lv > 0 ? `tac-heat-${lv}` : undefined} />;
          })}
        </span>
      </div>
      {/* S7 图例小字：磁贴底衬四色 + 口径声明（原文照 spec §6，半角逗号）+ CA 参考口径（§3 修订） */}
      <p className="tac-fit-legend">
        <span>磁贴底衬：</span>
        <i className="tac-fit-sw fit-g" aria-hidden="true" /> 合适 ≥85
        <i className="tac-fit-sw fit-y" aria-hidden="true" /> 中游 50–84
        <i className="tac-fit-sw fit-o" aria-hidden="true" /> 浪费 &lt;50
        <i className="tac-fit-sw fit-na" aria-hidden="true" /> 无数据 / 非其位置群
        <span>CA/PA 仅作参考,不参与 FIT 计算</span>
        <span className="tac-fit-legal">
          FIT 适配度按最近一次同步的 FC26 属性与徽章加权估算,非游戏内 CAPA 或官方数值
        </span>
      </p>
      <ul className="tac-fit-list">
        {rows.map((row) => {
          const { player, score, tile, suffix, elsewhere } = row;
          const selected = player.id === currentPid;
          const expanded = expandedPid === player.id;
          const pills: { k: string; label: string; v: number }[] = [];
          for (const [k] of topAttrs) {
            const v = player.meta?.attrs?.[k];
            if (typeof v === "number" && Number.isFinite(v)) {
              pills.push({ k, label: FIT_ATTR_LABELS[k] ?? k, v: Math.round(v) });
            }
          }
          const chips: { psid: number; chs: string; en: string; tier: string }[] = [];
          if (prof) {
            const ps = player.meta?.playstyles ?? [];
            for (const base of prof.badges) {
              const psid = ps.includes(base + 100) ? base + 100 : ps.includes(base) ? base : 0;
              const info = psid ? getPlaystyle(psid) : null;
              if (info) chips.push({ psid, ...info });
            }
          }
          const bd = score?.breakdown;
          const maxC = bd ? Math.max(...bd.attr.map(([, , c]) => c), 0) : 0;
          const roleBonus = bd ? (bd.roleHit === 2 ? 5 : bd.roleHit === 1 ? 3 : 0) : 0;
          // 球员自己的角色档（游戏里的 role+ / role++，RoleID1-5）：挂在球员身上的静态属性，
          // 与当前槽无关，所以整行展示；命中当前槽的加 hit 高亮——明细里的「角色熟悉 +3/+5」
          // 就是它折算的，但这里只展示、不参与算分（口径见 shared/playerRoles.ts）。
          const ownRoles = playerOwnRoles(player.meta).slice(0, 3);
          // CA/PA 参考值（用户 2026-10-25 修订：可见但只作参考）——引擎不读、不进公式、
          // 不参与排序与档位（fitScore.ts 硬口径）；这里纯展示，行内 CA 列 + 明细 CA/PA 行
          const attrs = player.meta?.attrs;
          const num = (v: unknown): number | null =>
            typeof v === "number" && Number.isFinite(v) ? v : null;
          const ca = num(attrs?.CA);
          const pa = num(attrs?.PA);
          return (
            <li key={player.id}>
              <button
                type="button"
                className={`tac-fit-row${selected ? " sel" : ""}`}
                aria-pressed={selected}
                aria-expanded={expanded}
                onClick={() => {
                  // 点行 = 写入该槽（与上方 select 同一入口 setNames）+ 展开/收起构成明细
                  setExpandedPid(expanded ? null : player.id);
                  onPick(player.id);
                }}
              >
                <span className={`tac-fit-score${score ? "" : " none"}`}>
                  {score ? score.rankShown : "–"}
                </span>
                {/* CA 参考列：mono 小字紧跟行首分数；缺 CA 用占位符保持列对齐（无数据 ≠ 0） */}
                <span className="tac-fit-ca">{ca != null ? `CA ${Math.round(ca)}` : "CA –"}</span>
                <span className="tac-fit-main">
                  <span className="asg-top">
                    <span className="asg-name">
                      {player.number ? `#${player.number} ` : ""}
                      {player.name}
                    </span>
                    {suffix && <span className="asg-suffix">{suffix}</span>}
                    {selected && <span className="asg-cur">✓ 当前</span>}
                    {elsewhere.length > 0 && (
                      <span className="asg-elsewhere">已首发（{elsewhere.join("/")}）</span>
                    )}
                    {!score && <span className="asg-nodata">无数据</span>}
                  </span>
                  {(pills.length > 0 || chips.length > 0) && (
                    <span className="asg-attrs">
                      {pills.map((p) => (
                        <span className="asg-pill" key={p.k}>
                          {p.label} {p.v}
                        </span>
                      ))}
                      {chips.map((c) => (
                        <span className={`asg-chip ${c.tier}`} key={c.psid} title={c.en}>
                          {c.chs}
                        </span>
                      ))}
                    </span>
                  )}
                  {ownRoles.length > 0 && (
                    <span className="asg-attrs asg-own">
                      <span className="asg-own-label">自身角色</span>
                      {ownRoles.map((r) => {
                        const hit = r.slot === slotKey;
                        const zh = ROLE_FIT[r.slot]?.zh ?? `${r.pos} ${r.role}`;
                        return (
                          <span
                            key={r.slot}
                            className={`asg-role t${r.tier}${hit ? " hit" : ""}`}
                            title={`${r.pos} ${zh} · ${
                              r.tier === 2 ? "世界级（++）" : "熟悉（+）"
                            }${hit ? " · 就是当前槽位" : ""}`}
                          >
                            {ownRoleTag(r)}
                          </span>
                        );
                      })}
                    </span>
                  )}
                </span>
              </button>
              {/* 展开明细：「分数为什么是这个数」——属性贡献条 + 加分 + 个人内契合（spec §5.2） */}
              {expanded && score && bd && (
                <div className="tac-fit-bd">
                  {bd.attr.map(([k, v, c]) => (
                    <div className="tac-fit-bd-row" key={k}>
                      <span className="tac-fit-bd-name">{FIT_ATTR_LABELS[k] ?? k}</span>
                      <span className="tac-fit-bd-val">{Math.round(v)}</span>
                      <span className="tac-fit-bd-track">
                        {/* 条长 ∝ 属性×权重（贡献），行内按最大贡献归一；确切数值在左列 mono */}
                        <i
                          style={{ width: maxC > 0 ? `${Math.max(4, (c / maxC) * 100)}%` : "0%" }}
                        />
                      </span>
                    </div>
                  ))}
                  <p className="tac-fit-bd-note">
                    属性加权 {Math.round(score.base)} + 徽章 +{score.badge}
                    {bd.posHit ? " + 位置匹配 2" : ""}
                    {roleBonus > 0 ? ` + 角色熟悉 ${roleBonus}` : ""} ={" "}
                    {Number(score.rankRaw.toFixed(1))}
                    {score.rankShown < score.rankRaw ? "（显示封顶 99）" : ""}
                  </p>
                  <p className="tac-fit-bd-note">
                    个人内契合 <b>{tile ?? "无"}</b>（磁贴底衬色，和自己比）
                  </p>
                  {/* CA/PA 明细行：整体水平对照用，标注不参与 FIT 计算（spec §3 修订口径） */}
                  {(ca != null || pa != null) && (
                    <p className="tac-fit-bd-note">
                      CA {ca != null ? Math.round(ca) : "–"} · PA{" "}
                      {pa != null ? Math.round(pa) : "–"}(参考值,不参与 FIT 计算)
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
