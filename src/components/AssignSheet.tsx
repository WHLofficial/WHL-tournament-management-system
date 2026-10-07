// 手机底部弹层：战术页点槽位 chip 时开（窄屏才走这条路），只展示该槽的候选列表，不画半场示意图。
// 候选行、排序、互斥预检与会话页共用 AssignCandidateList，两端口径一致。
import { useEffect } from "react";
import { ASSIGN_GROUP_OF, ASSIGN_LABEL, type AssignKey } from "../../shared/tactics";
import { AssignCandidateList, type AssignCandidateItem } from "./AssignCandidate";

export function AssignSheet({
  assignKey,
  players,
  assign,
  suffixOf,
  onPick,
  onClear,
  onClose,
}: {
  assignKey: AssignKey;
  players: readonly AssignCandidateItem[];
  assign: Record<string, number>;
  /** 伤停 / 停赛后缀（口径见 lib/assignCandidates 的 statusSuffix） */
  suffixOf: (playerId: number) => string;
  onPick: (playerId: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const group = ASSIGN_GROUP_OF[assignKey];
  const label = ASSIGN_LABEL[assignKey];
  // Esc 关（与仓内 ShareDialog / 球员卡同一套做法）：手机外接键盘与桌面窗口都没别的出口时好收
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <button
        type="button"
        className="asg-sheet-scrim"
        aria-label="关闭候选列表"
        onClick={onClose}
      />
      <section className="asg-sheet" role="dialog" aria-modal="true" aria-label={`${group} · ${label}`}>
        <header className="asg-sheet-head">
          <h3>
            {label}
            <small>{group}</small>
          </h3>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="asg-sheet-body">
          {players.length === 0 ? (
            <p className="asg-sheet-empty">
              场上 11 个位置还没选满：先把首发填好，候选只从本场首发里出。
            </p>
          ) : (
            <AssignCandidateList
              players={players}
              assignKey={assignKey}
              assign={assign}
              suffixOf={suffixOf}
              onPick={onPick}
              onClear={onClear}
            />
          )}
        </div>
      </section>
    </>
  );
}
