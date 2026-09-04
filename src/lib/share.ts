import QRCode from "qrcode";

// 分享卡片绘制库：800×1000 竖版 canvas，深色球场底 + 二维码。
// 队徽缺失时按队名 hash 取色画色块+首字（与 TeamLogo 组件同款色板）。

export const CARD_W = 800;
export const CARD_H = 1000;

const PALETTE = ["#0e7a46", "#e8590c", "#1971c2", "#9c36b5", "#e64980", "#f08c00"];
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

export interface ShareTeam {
  name: string;
  logoUrl?: string | null;
}

export interface ShareMatch {
  home: ShareTeam;
  away: ShareTeam;
  scoreHome: number | null;
  scoreAway: number | null;
  penHome?: number | null;
  penAway?: number | null;
  status: "pending" | "live" | "finished";
  note?: string | null;
}

export interface TournamentCardData {
  name: string;
  subtitle: string;
  coverUrl?: string | null;
  resultLabel: string;
  matches: ShareMatch[];
  url: string;
}

export interface MatchCardData {
  tournamentName: string;
  subtitle: string;
  match: ShareMatch;
  eventLines?: string[];
  url: string;
}

export interface RoundCardData {
  tournamentName: string;
  title: string;
  matches: ShareMatch[];
  url: string;
}

export interface TableCardData {
  tournamentName: string;
  title: string;
  columns: string[];
  rows: string[][];
  url: string;
}

function colorOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function loadImg(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function font(ctx: CanvasRenderingContext2D, weight: number | string, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

async function drawTeamBadge(
  ctx: CanvasRenderingContext2D,
  team: ShareTeam,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  const img = team.logoUrl ? await loadImg(team.logoUrl) : null;
  roundRectPath(ctx, x, y, size, size, Math.round(size * 0.22));
  ctx.save();
  ctx.clip();
  if (img) {
    const s = Math.max(size / img.width, size / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = colorOf(team.name);
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    font(ctx, 700, Math.round(size * 0.5));
    ctx.fillText(team.name.slice(0, 1), x + size / 2, y + size / 2 + 1);
  }
  ctx.restore();
}

async function drawQr(ctx: CanvasRenderingContext2D, url: string): Promise<void> {
  const size = 168;
  const x = CARD_W - size - 44;
  const y = CARD_H - size - 40;
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  roundRectPath(ctx, x - 10, y - 10, size + 20, size + 20, 14);
  ctx.fill();
  const off = document.createElement("canvas");
  await QRCode.toCanvas(off, url, {
    width: size,
    margin: 0,
    color: { dark: "#12241b", light: "#ffffff" },
  });
  ctx.drawImage(off, x, y);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  font(ctx, 400, 15);
  ctx.fillText("扫码打开这个页面", x - 10, y + size + 32);
}

// 画卡底：渐变球场绿 + 顶部标题区。返回内容区起始 y。
function drawBase(
  ctx: CanvasRenderingContext2D,
  title: string,
  subtitle: string,
): number {
  const grad = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  grad.addColorStop(0, "#0a3d24");
  grad.addColorStop(1, "#116237");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 球场中圈装饰
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CARD_W / 2, CARD_H / 2, 230, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(CARD_W / 2, 0);
  ctx.lineTo(CARD_W / 2, CARD_H);
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  font(ctx, 700, 40);
  ctx.fillText(fitText(ctx, title, CARD_W - 96), 48, 76);
  font(ctx, 400, 20);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillText(fitText(ctx, subtitle, CARD_W - 96), 48, 112);

  ctx.fillStyle = "rgba(240,200,90,0.9)";
  ctx.fillRect(48, 130, 56, 4);
  return 170;
}

// 一行对阵：主队名贴中左侧、客队名贴中右侧、中间比分/vs 胶囊
async function drawMatchLine(
  ctx: CanvasRenderingContext2D,
  m: ShareMatch,
  y: number,
): Promise<void> {
  const cx = CARD_W / 2;
  const badge = 34;
  const gap = 10;
  font(ctx, 600, 21);

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const homeName = fitText(ctx, m.home.name, cx - badge - 76);
  ctx.fillStyle = "#fff";
  ctx.fillText(homeName, cx - badge / 2 - gap, y);
  await drawTeamBadge(ctx, m.home, cx - badge / 2 - gap - ctx.measureText(homeName).width - badge, y - badge / 2, badge);

  ctx.textAlign = "left";
  const awayName = fitText(ctx, m.away.name, cx - badge - 76);
  ctx.fillStyle = "#fff";
  ctx.fillText(awayName, cx + badge / 2 + gap, y);
  await drawTeamBadge(ctx, m.away, cx + badge / 2 + gap + ctx.measureText(awayName).width + 4, y - badge / 2, badge);

  // 中央胶囊
  const pill = 88;
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  roundRectPath(ctx, cx - pill / 2, y - 22, pill, 44, 22);
  ctx.fill();
  ctx.textAlign = "center";
  if (m.status === "finished") {
    font(ctx, 700, 22);
    ctx.fillStyle = "#fff";
    ctx.fillText(`${m.scoreHome ?? 0} : ${m.scoreAway ?? 0}`, cx, y + 1);
  } else if (m.status === "live") {
    font(ctx, 700, 22);
    ctx.fillStyle = "#ffb37a";
    ctx.fillText(`${m.scoreHome ?? 0} : ${m.scoreAway ?? 0}`, cx, y + 1);
  } else {
    font(ctx, 600, 18);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText("vs", cx, y + 1);
  }
  if (m.status === "finished" && (m.penHome != null || m.penAway != null)) {
    font(ctx, 400, 13);
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(`点球 ${m.penHome} : ${m.penAway}`, cx, y + 36);
  }
  if (m.status === "live") {
    ctx.fillStyle = "#ff7a33";
    ctx.beginPath();
    ctx.arc(cx + pill / 2 + 10, y - 12, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFootBrand(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  font(ctx, 700, 26);
  ctx.fillText("WHL 赛事", 48, CARD_H - 64);
  font(ctx, 400, 14);
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.fillText("由 WHL 赛事系统生成", 48, CARD_H - 36);
}

async function drawCover(ctx: CanvasRenderingContext2D, url: string | null | undefined, y: number, h: number): Promise<number> {
  if (!url) return y;
  const img = await loadImg(url);
  if (!img) return y;
  const x = 48;
  const w = CARD_W - 96;
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.clip();
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
  return y + h + 18;
}

function sectionLabel(ctx: CanvasRenderingContext2D, text: string, y: number): void {
  font(ctx, 600, 17);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, 48, y);
}

// 赛事卡：封面 + 近期赛果/对阵预告
export async function drawTournamentCard(canvas: HTMLCanvasElement, data: TournamentCardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let y = drawBase(ctx, data.name, data.subtitle);
  y = await drawCover(ctx, data.coverUrl, y, 300);

  const listY = y + 34;
  sectionLabel(ctx, data.resultLabel, listY);
  const list = data.matches.slice(0, 4);
  let my = listY + 46;
  for (const m of list) {
    await drawMatchLine(ctx, m, my);
    my += 66;
  }
  if (list.length === 0) {
    font(ctx, 400, 18);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("比赛安排即将公布", 48, my);
  }
  drawFootBrand(ctx);
  await drawQr(ctx, data.url);
}

// 单场卡：大比分 + 事件行
export async function drawMatchCard(canvas: HTMLCanvasElement, data: MatchCardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawBase(ctx, data.tournamentName, data.subtitle);
  const m = data.match;
  const cy = 400;
  const badge = 96;
  const cx = CARD_W / 2;

  font(ctx, 700, 30);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const homeName = fitText(ctx, m.home.name, cx - badge - 160);
  ctx.fillText(homeName, cx - 130, cy);
  await drawTeamBadge(ctx, m.home, cx - 130 - ctx.measureText(homeName).width - badge - 12, cy - badge / 2, badge);

  ctx.textAlign = "left";
  const awayName = fitText(ctx, m.away.name, cx - badge - 160);
  ctx.fillText(awayName, cx + 130, cy);
  await drawTeamBadge(ctx, m.away, cx + 130 + ctx.measureText(awayName).width + 12, cy - badge / 2, badge);

  ctx.textAlign = "center";
  if (m.status === "pending") {
    font(ctx, 700, 64);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("vs", cx, cy);
    font(ctx, 400, 18);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("未开打", cx, cy + 56);
  } else {
    font(ctx, 700, 72);
    ctx.fillStyle = m.status === "live" ? "#ffb37a" : "#fff";
    ctx.fillText(`${m.scoreHome ?? 0} : ${m.scoreAway ?? 0}`, cx, cy);
    if (m.penHome != null || m.penAway != null) {
      font(ctx, 600, 22);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(`点球 ${m.penHome} : ${m.penAway}`, cx, cy + 52);
    }
    if (m.status === "live") {
      font(ctx, 600, 20);
      ctx.fillStyle = "#ff7a33";
      ctx.fillText("● 进行中", cx, cy + 52);
    }
  }
  if (m.note) {
    font(ctx, 400, 16);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(fitText(ctx, m.note, CARD_W - 96), cx, cy - 78);
  }

  const lines = (data.eventLines ?? []).slice(0, 6);
  if (lines.length > 0) {
    let ey = cy + 140;
    sectionLabel(ctx, "比赛事件", ey - 30);
    font(ctx, 400, 17);
    ctx.textBaseline = "middle";
    for (const line of lines) {
      ctx.fillStyle = "rgba(255,255,255,0.78)";
      ctx.textAlign = "center";
      ctx.fillText(fitText(ctx, line, CARD_W - 96), cx, ey);
      ey += 30;
    }
  }
  drawFootBrand(ctx);
  await drawQr(ctx, data.url);
}

// 轮次卡：该轮全部对阵
export async function drawRoundCard(canvas: HTMLCanvasElement, data: RoundCardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let y = drawBase(ctx, data.tournamentName, data.title);
  sectionLabel(ctx, "本轮对阵", y + 20);
  let my = y + 60;
  const list = data.matches.slice(0, 7);
  for (const m of list) {
    await drawMatchLine(ctx, m, my);
    my += 72;
  }
  if (data.matches.length > 7) {
    font(ctx, 400, 16);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.textAlign = "center";
    ctx.fillText(`还有 ${data.matches.length - 7} 场未展示`, CARD_W / 2, my);
  }
  drawFootBrand(ctx);
  await drawQr(ctx, data.url);
}

// 通用表卡：积分榜 / 球员球队榜单共用
export async function drawTableCard(canvas: HTMLCanvasElement, data: TableCardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let y = drawBase(ctx, data.tournamentName, data.title);

  const x = 48;
  const w = CARD_W - 96;
  const cols = data.columns.length;
  const colW = w / cols;
  const rowH = 46;
  const maxRows = Math.floor((CARD_H - 260 - (y + 40)) / rowH);
  const rows = data.rows.slice(0, maxRows);

  // 表头
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  roundRectPath(ctx, x, y + 16, w, rowH, 10);
  ctx.fill();
  font(ctx, 600, 16);
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.textBaseline = "middle";
  data.columns.forEach((c, i) => {
    ctx.textAlign = i === 0 ? "center" : i === 1 ? "left" : "center";
    ctx.fillText(c, x + colW * i + (i === 1 ? 16 : colW / 2), y + 16 + rowH / 2);
  });

  let ry = y + 16 + rowH + 6;
  font(ctx, 500, 17);
  rows.forEach((row, ri) => {
    if (ri % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      roundRectPath(ctx, x, ry, w, rowH - 4, 8);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    row.forEach((cell, ci) => {
      ctx.textAlign = ci === 0 ? "center" : ci === 1 ? "left" : "center";
      ctx.fillText(fitText(ctx, cell, colW - 12), x + colW * ci + (ci === 1 ? 16 : colW / 2), ry + (rowH - 4) / 2);
    });
    ry += rowH;
  });
  if (data.rows.length > rows.length) {
    font(ctx, 400, 14);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.textAlign = "center";
    ctx.fillText(`仅展示前 ${rows.length} 项，扫码看完整榜单`, CARD_W / 2, ry + 6);
  }
  drawFootBrand(ctx);
  await drawQr(ctx, data.url);
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}
