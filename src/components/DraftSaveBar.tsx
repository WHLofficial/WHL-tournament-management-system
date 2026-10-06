/** 未保存更改保存条：淘汰赛落位草稿与小组/循环排赛草稿共用 */
export default function DraftSaveBar({
  label,
  saving,
  error,
  onSave,
  onDiscard,
}: {
  label: string;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="draft-bar">
      <span>{label}</span>
      <button className="btn btn-sm" type="button" disabled={saving} onClick={onSave}>
        {saving ? "保存中…" : "保存"}
      </button>
      <button
        className="btn btn-sm btn-danger-ghost"
        type="button"
        disabled={saving}
        onClick={() => {
          if (window.confirm("放弃这些未保存的更改？")) onDiscard();
        }}
      >
        放弃
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
