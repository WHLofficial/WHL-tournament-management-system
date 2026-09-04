// 默认赛事封面：创建赛事时生成一次存 R2，之后改名不重生成；
// 用 SVG（文字由浏览器渲染）——Workers 无字体无法光栅化中文成位图
const FONT_STACK = `'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',sans-serif`;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  );

function titleAttrs(name: string): string {
  const n = [...name].length;
  const fs = n <= 8 ? 68 : n <= 14 ? 52 : n <= 20 ? 42 : 34;
  // 粗略估宽：CJK 全宽、其余约 0.6 倍；超出安全区则强制压缩到 560px
  let w = 0;
  for (const ch of name) w += ch.codePointAt(0)! > 0x2e80 ? fs : fs * 0.6;
  const tl = w > 560 ? ` textLength="560" lengthAdjust="spacingAndGlyphs"` : "";
  return `font-size="${fs}"${tl}`;
}

export function defaultCoverSvg(name: string, year: number): string {
  const stripes: string[] = [];
  for (let i = 0; i < 6; i++) {
    const y = 200 + i * 26.66;
    stripes.push(
      `<rect x="0" y="${y.toFixed(1)}" width="640" height="26.7" fill="${i % 2 ? "#13814f" : "#0e7a46"}"/>`
    );
  }
  // 文字放在中央安全带（y 98~261）：banner 容器 object-fit:cover 会裁掉上下各约 98px
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#0b3320"/><stop offset="1" stop-color="#175936"/>
</linearGradient></defs>
<rect width="640" height="360" fill="url(#sky)"/>
${stripes.join("\n")}
<line x1="0" y1="272" x2="640" y2="272" stroke="#f4f6f3" stroke-width="4"/>
<circle cx="320" cy="272" r="56" fill="none" stroke="#f4f6f3" stroke-width="4"/>
<circle cx="320" cy="272" r="5" fill="#f4f6f3"/>
<text x="320" y="185" text-anchor="middle" font-family="${FONT_STACK}" font-weight="700" fill="#ffffff" ${titleAttrs(name)}>${esc(name)}</text>
<text x="320" y="238" text-anchor="middle" font-family="${FONT_STACK}" font-weight="700" font-size="30" letter-spacing="2" fill="#f0c850">WH League ${year}</text>
</svg>`;
}

// 写入 R2 并返回版本化 key；调用方负责把 key 落库、失败自行兜底
export async function putDefaultCover(
  env: { MEDIA: R2Bucket },
  tournamentId: number,
  name: string
): Promise<string> {
  const svg = defaultCoverSvg(name, new Date().getFullYear());
  const key = `tournament/${tournamentId}/${Date.now()}.svg`;
  await env.MEDIA.put(key, svg, { httpMetadata: { contentType: "image/svg+xml" } });
  return key;
}
