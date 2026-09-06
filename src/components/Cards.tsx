// 牌类事件图标：CSS 画的纯色圆角矩形（打样定稿 C 方案）。
// 不用系统 emoji——Windows 下 Segoe 的黄牌偏橙且无法改色。
// kind: red=单红牌 yellow=单黄牌 red_2y=黄牌在下、红牌叠右上带描边
export function CardIcon({ kind }: { kind: "red" | "yellow" | "red_2y" }) {
  if (kind === "red_2y") return <span className="fcard fcard-pair" title="两黄变一红" />;
  return (
    <span
      className={`fcard fcard-single ${kind === "red" ? "fcard-red" : "fcard-yellow"}`}
      title={kind === "red" ? "红牌" : "黄牌"}
    />
  );
}

// 管理端事件列表的圆点标记：牌类用 CSS 牌，其余保持原圆点
export function EventDot({ type }: { type: string }) {
  if (type === "red" || type === "yellow" || type === "red_2y")
    return <CardIcon kind={type} />;
  return <span className={`ev-dot ev-${type}`} />;
}
