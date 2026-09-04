import type { CSSProperties } from "react";

// 固定色板（球场记分牌色系）：无队徽时按队名 hash 取色，同一队永远同色
const PALETTE = ["#0e7a46", "#e8590c", "#1971c2", "#9c36b5", "#e64980", "#f08c00"];

function colorOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// 队徽：有图显示图；无图显示队名首字 + 固定色块
export function TeamLogo({
  name,
  url,
  size = 24,
}: {
  name: string;
  url?: string | null;
  size?: number;
}) {
  const box: CSSProperties = { width: size, height: size };
  if (url) {
    return <img className="team-logo" src={url} alt={name} style={box} />;
  }
  return (
    <span
      className="team-logo team-logo-fallback"
      style={{ ...box, background: colorOf(name), fontSize: Math.max(10, Math.round(size * 0.46)) }}
    >
      {name.slice(0, 1)}
    </span>
  );
}
