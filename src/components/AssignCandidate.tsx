// 指派候选行 / 候选列表：手机底部弹层与桌面编排页共用同一套渲染口径。
// 两行式 —— 第一行号码/位置/姓名 + 状态后缀（+ 选中与互斥冲突标记），
// 第二行角色相关属性 pill + 金银徽章 chip（角色不看属性也不看徽章时整行不出现）。
import { ASSIGN_GROUP_OF, ASSIGN_LABEL, ASSIGN_RELEVANCE, type AssignKey } from "../../shared/tactics";
import type { LineupPlayerDTO, PlayerMeta } from "../../shared/types";
import {
  assignAttrPills,
  assignBadgeChip,
  conflictingKey,
  hasFc26Data,
  sortAssignCandidates,
} from "../lib/assignCandidates";

/** 候选池里的一行：DTO 再叠一个位置码（战术页池子的 pos，如 "LB/LCB"） */
export type AssignCandidateItem = LineupPlayerDTO & { pos?: string };

/** 金 / 银徽章 chip（配色照定案；LineupView 的 AssignList 也用它） */
export function AssignBadgeTag({
  meta,
  assignKey,
}: {
  meta?: PlayerMeta;
  assignKey: AssignKey;
}) {
  const chip = assignBadgeChip(meta, assignKey);
  if (!chip) return null;
  return (
    <span className={`asg-chip ${chip.tier}`} title={chip.en}>
      {chip.chs}
    </span>
  );
}

export function AssignCandidateRow({
  player,
  assignKey,
  pos,
  suffix,
  selected,
  conflict,
  onPick,
}: {
  player: AssignCandidateItem;
  assignKey: AssignKey;
  /** 位置码（可选；编排页从首发池带过来） */
  pos?: string;
  /** 伤停 / 停赛后缀（口径见 lib/assignCandidates 的 statusSuffix） */
  suffix?: string;
  selected: boolean;
  /** 与当前互斥槽位撞车（仍可点选，提交时后端拦） */
  conflict?: AssignKey | null;
  onPick: () => void;
}) {
  const pills = assignAttrPills(player.meta, assignKey);
  const badge = assignBadgeChip(player.meta, assignKey);
  // 属性行只在角色确实要看点什么的时候出现：队长 / 界外球既无属性也无徽章，不画空行
  const relevance = ASSIGN_RELEVANCE[assignKey];
  const wantsAttrs = relevance.attrKeys.length > 0 || relevance.badge !== undefined;
  const noData = wantsAttrs && !hasFc26Data(player.meta);
  return (
    <button
      type="button"
      className={`asg-row${selected ? " sel" : ""}`}
      aria-pressed={selected}
      onClick={onPick}
    >
      <span className="asg-top">
        <span className="asg-name">
          {player.number ? `#${player.number} ` : ""}
          {pos && <em className="asg-pos">{pos}</em>}
          {player.name ?? "已离队"}
        </span>
        {suffix && <span className="asg-suffix">{suffix}</span>}
        {selected && <span className="asg-cur">✓ 当前</span>}
        {conflict && (
          <span className="asg-warn">
            ⚠ 已指定：{ASSIGN_GROUP_OF[conflict]} · {ASSIGN_LABEL[conflict]}
          </span>
        )}
      </span>
      {(pills.length > 0 || badge !== null || noData) && (
        <span className="asg-attrs">
          {pills.map((p) => (
            <span className="asg-pill" key={p.key}>
              {p.label} {p.value}
            </span>
          ))}
          {badge && (
            <span className={`asg-chip ${badge.tier}`} title={badge.en}>
              {badge.chs}
            </span>
          )}
          {noData && <span className="asg-nodata">无数据</span>}
        </span>
      )}
    </button>
  );
}

/** 「不指定」：清空该槽，恒排在候选列表最后一行 */
export function AssignNoneRow({ selected, onPick }: { selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`asg-row asg-none${selected ? " sel" : ""}`}
      aria-pressed={selected}
      onClick={onPick}
    >
      <span className="asg-top">
        <span className="asg-name">不指定</span>
        {selected && <span className="asg-cur">✓ 当前</span>}
      </span>
    </button>
  );
}

/**
 * 候选列表：按相关性排序 + 固定末尾的「不指定」；冲突与选中态都从 assign 现算，
 * 所以弹层与编排页共用这一份即可保证两端口径一致。suffixOf 由调用方提供（状态数据在页面里）。
 */
export function AssignCandidateList({
  players,
  assignKey,
  assign,
  suffixOf,
  onPick,
  onClear,
}: {
  players: readonly AssignCandidateItem[];
  assignKey: AssignKey;
  assign: Record<string, number>;
  suffixOf?: (playerId: number) => string;
  onPick: (playerId: number) => void;
  onClear: () => void;
}) {
  const current = assign[assignKey] ?? null;
  return (
    <ul className="asg-list">
      {sortAssignCandidates(players, assignKey).map((p) => (
        <li key={p.playerId}>
          <AssignCandidateRow
            player={p}
            assignKey={assignKey}
            pos={p.pos}
            suffix={suffixOf?.(p.playerId) ?? ""}
            selected={p.playerId === current}
            conflict={conflictingKey(assign, assignKey, p.playerId)}
            onPick={() => onPick(p.playerId)}
          />
        </li>
      ))}
      <li>
        <AssignNoneRow selected={current === null} onPick={onClear} />
      </li>
    </ul>
  );
}
