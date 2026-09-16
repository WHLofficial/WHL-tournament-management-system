import QRCode from "qrcode";

// 分享卡片绘制库：800×1000 竖版 canvas，深色球场底 + 二维码。
// 队徽缺失时按队名 hash 取色画色块+首字（与 TeamLogo 组件同款色板）。

export const CARD_W = 800;
/** 基准高度：内容不足时保持 4:5 海报比例，内容多时自动拉高成长图 */
export const CARD_H = 1000;

const PALETTE = ["#0e7a46", "#e8590c", "#1971c2", "#9c36b5", "#e64980", "#f08c00"];
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

export interface ShareTeam {
  name: string;
  logoUrl?: string | null;
}

export interface ShareEvent {
  type: string;
  side: "home" | "away";
  playerName: string | null;
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
  events?: ShareEvent[];
}

// MatchDTO 等兼容结构 → ShareMatch（待定队占位名）
export interface ShareMatchInput {
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeLogoUrl?: string | null;
  awayLogoUrl?: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  penHome: number | null;
  penAway: number | null;
  status: "pending" | "live" | "finished";
  note?: string | null;
  events?: { type: string; side: "home" | "away"; playerName: string | null }[];
}

export function matchToShare(m: ShareMatchInput): ShareMatch {
  return {
    home: { name: m.homeTeamName ?? "待定", logoUrl: m.homeLogoUrl ?? null },
    away: { name: m.awayTeamName ?? "待定", logoUrl: m.awayLogoUrl ?? null },
    scoreHome: m.scoreHome,
    scoreAway: m.scoreAway,
    penHome: m.penHome,
    penAway: m.penAway,
    status: m.status,
    note: m.note ?? null,
    events: m.events ?? [],
  };
}

// 对阵行事件摘要 token：⚽进球（点球不特殊标注，乌龙归受益侧标 OG）+ 🟥红牌（含两黄变一红）。
// 同一人多球聚合 ×n。返回主/客两侧的按人 token，供贪心换行（放不下才按人断行）。
function eventSummaryTokens(m: ShareMatch): { home: string[]; away: string[] } {
  const goals: Record<"home" | "away", Map<string, number>> = { home: new Map(), away: new Map() };
  const reds: Record<"home" | "away", string[]> = { home: [], away: [] };
  for (const e of m.events ?? []) {
    const name = e.playerName || "球员";
    if (e.type === "goal" || e.type === "pen_goal") {
      goals[e.side].set(name, (goals[e.side].get(name) ?? 0) + 1);
    } else if (e.type === "own_goal") {
      const s = e.side === "home" ? "away" : "home";
      const key = `${name}(OG)`;
      goals[s].set(key, (goals[s].get(key) ?? 0) + 1);
    } else if (e.type === "red" || e.type === "red_2y") {
      reds[e.side].push(name);
    }
  }
  const fmt = (side: "home" | "away"): string[] => {
    const tokens: string[] = [];
    const names = [...goals[side].entries()].map(([n, c]) => (c >= 2 ? `${n} ×${c}` : n));
    if (names.length > 0) tokens.push(`⚽ ${names[0]}`, ...names.slice(1));
    if (reds[side].length > 0) tokens.push(`🟥 ${reds[side][0]}`, ...reds[side].slice(1));
    return tokens;
  };
  return { home: fmt("home"), away: fmt("away") };
}

// 对阵行摘要几何常量：drawMatchLine 与卡片高度预测量共用，两侧对称
const LINE_PILL = 88;
const LINE_GAP_PILL = 12;
const SUM_LINE_H = 22; // 摘要折行行距（14px 字号）
// 摘要从胶囊锚点向画布边距方向展开，两侧可用宽度相同
const MATCHLINE_SUM_W = CARD_W / 2 - LINE_PILL / 2 - LINE_GAP_PILL - 48;

// 摘要按人贪心换行：一行尽量多放（", " 连接），放不下才换行；
// 最多 maxLines 行，仍有装不下的人时末行加省略号。返回绘制用行数组。
function summaryLines(
  ctx: CanvasRenderingContext2D,
  tokens: string[],
  maxWidth: number,
  maxLines = 3,
): string[] {
  if (tokens.length === 0) return [];
  font(ctx, 400, 14);
  const lines: string[] = [];
  let i = 0;
  while (i < tokens.length && lines.length < maxLines) {
    let cur = tokens[i++];
    while (i < tokens.length && ctx.measureText(`${cur}, ${tokens[i]}`).width <= maxWidth) {
      cur = `${cur}, ${tokens[i++]}`;
    }
    if (ctx.measureText(cur).width > maxWidth) cur = fitText(ctx, cur, maxWidth);
    lines.push(cur);
  }
  if (i < tokens.length) lines[lines.length - 1] = fitText(ctx, `${lines[lines.length - 1]}…`, maxWidth);
  return lines;
}

// 摘要换行的统一入口：drawMatchLine 绘制与轮次/赛事卡高度预测量共用同一结果
function matchSummaryLines(
  ctx: CanvasRenderingContext2D,
  m: ShareMatch,
  maxWHome = MATCHLINE_SUM_W,
  maxWAway = MATCHLINE_SUM_W,
): { home: string[]; away: string[] } {
  const t = eventSummaryTokens(m);
  return { home: summaryLines(ctx, t.home, maxWHome), away: summaryLines(ctx, t.away, maxWAway) };
}

export interface TournamentCardData {
  name: string;
  subtitle: string;
  coverUrl?: string | null;
  resultLabel: string;
  matches: ShareMatch[];
  url: string;
}

export interface ShareEventRow {
  side: "home" | "away";
  icon: string;
  /** 牌类事件：canvas 直接画纯色矩形（与页面 CSS 牌同款），不走 emoji 字体 */
  card?: "red" | "yellow" | "red_2y";
  tag?: string | null;
  minute: number | null;
  playerName: string | null;
  assistName?: string | null;
}

// canvas 小牌：与页面 CSS 牌同配色；红牌带深底描边（叠在黄牌上时分层）。返回占用宽度。
function drawCardMark(
  ctx: CanvasRenderingContext2D,
  kind: "red" | "yellow" | "red_2y",
  x: number,
  cy: number
): number {
  const w = 11;
  const h = 15;
  const top = cy - h / 2 - 1;
  const rect = (px: number, py: number, color: string, outline: boolean) => {
    if (outline) {
      ctx.fillStyle = "#0e5030";
      roundRectPath(ctx, px - 1.5, py - 1.5, w + 3, h + 3, 3.5);
      ctx.fill();
    }
    ctx.fillStyle = color;
    roundRectPath(ctx, px, py, w, h, 2.5);
    ctx.fill();
  };
  if (kind === "red") rect(x, top, "#e53935", false);
  else if (kind === "yellow") rect(x, top, "#ffd60a", false);
  else {
    rect(x, top + 3, "#ffd60a", false);
    rect(x + 7, top, "#e53935", true);
  }
  return kind === "red_2y" ? w + 7 : w;
}

export interface MatchCardData {
  tournamentName: string;
  subtitle: string;
  coverUrl?: string | null;
  match: ShareMatch;
  eventRows?: ShareEventRow[];
  url: string;
}

export interface RoundCardData {
  tournamentName: string;
  title: string;
  coverUrl?: string | null;
  matches: ShareMatch[];
  url: string;
}

export interface TableCardData {
  tournamentName: string;
  title: string;
  coverUrl?: string | null;
  columns: string[];
  rows: string[][];
  url: string;
  /** 每列相对宽度权重（如队名列加宽），不传则均分 */
  colWidths?: number[];
  /** 左对齐的名称列序号（默认第 1 列；可传多个，如榜单的球员+球队列） */
  nameCol?: number | number[];
  /** 排名段标记（积分榜）：跟随赛事展示样式设置；rowColors 与 rows 同序 */
  zones?: {
    style: "strip" | "divider";
    rowColors: (string | null)[];
    legend: { color: string; name: string; range: string }[];
    dividers: { afterRow: number; color: string; name: string }[];
  };
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

async function drawQr(ctx: CanvasRenderingContext2D, url: string, h: number): Promise<void> {
  const size = 168;
  const x = CARD_W - size - 44;
  const y = h - size - 40;
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
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  font(ctx, 400, 15);
  ctx.fillText("扫码打开这个页面", x + size + 10, y + size + 32);
}

// 画卡底：渐变球场绿 + 中圈装饰（标题区由各卡自行排）
function drawBaseBg(ctx: CanvasRenderingContext2D, h: number): void {
  const grad = ctx.createLinearGradient(0, 0, CARD_W, h);
  grad.addColorStop(0, "#0a3d24");
  grad.addColorStop(1, "#116237");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, h);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CARD_W / 2, h / 2, 230, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(CARD_W / 2, 0);
  ctx.lineTo(CARD_W / 2, h);
  ctx.stroke();
}

// 封面打头标题区：封面 + 赛事名 + 副标题 + 金线。返回内容区起始 y。
async function drawCoverHeader(
  ctx: CanvasRenderingContext2D,
  coverUrl: string | null | undefined,
  title: string,
  subtitle: string,
  coverH: number,
): Promise<number> {
  const end = await drawCover(ctx, coverUrl, 36, coverH);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  font(ctx, 700, 40);
  ctx.fillText(fitText(ctx, title, CARD_W - 96), 48, end + 40);
  font(ctx, 400, 20);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillText(fitText(ctx, subtitle ?? "", CARD_W - 96), 48, end + 76);
  ctx.fillStyle = "rgba(240,200,90,0.9)";
  ctx.fillRect(48, end + 96, 56, 4);
  return end + 140;
}

// 一行对阵：主队名贴中左侧、客队名贴中右侧、中间比分/vs 胶囊
async function drawMatchLine(
  ctx: CanvasRenderingContext2D,
  m: ShareMatch,
  y: number,
  lines: { home: string[]; away: string[] },
): Promise<void> {
  const cx = CARD_W / 2;
  const badge = 34;
  const pill = LINE_PILL;
  const gapPill = LINE_GAP_PILL; // 文字与胶囊的间隙
  const gapBadge = 8; // 文字与徽标的间隙
  font(ctx, 600, 21);

  // 文字锚点在胶囊外侧，徽标再往外；保证最长文字（fitText 截断后）也不碰胶囊、不越边距
  const anchorH = cx - pill / 2 - gapPill;
  const anchorA = cx + pill / 2 + gapPill;
  const textMax = anchorH - 48 - badge - gapBadge;

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const homeName = fitText(ctx, m.home.name, textMax);
  ctx.fillStyle = "#fff";
  ctx.fillText(homeName, anchorH, y);
  const hw = ctx.measureText(homeName).width;
  await drawTeamBadge(ctx, m.home, anchorH - hw - gapBadge - badge, y - badge / 2, badge);

  ctx.textAlign = "left";
  const awayName = fitText(ctx, m.away.name, textMax);
  ctx.fillStyle = "#fff";
  ctx.fillText(awayName, anchorA, y);
  const aw = ctx.measureText(awayName).width;
  await drawTeamBadge(ctx, m.away, anchorA + aw + gapBadge, y - badge / 2, badge);

  // 中央胶囊
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
  // 事件摘要：主侧贴胶囊左侧右对齐、客侧贴胶囊右侧左对齐，与点球括注同排（水平错开）；
  // 名单放不下时按人折行（行距 SUM_LINE_H），行数组由调用方预算传入
  if (lines.home.length > 0 || lines.away.length > 0) {
    font(ctx, 400, 14);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.textBaseline = "middle";
    if (lines.home.length > 0) {
      ctx.textAlign = "right";
      lines.home.forEach((ln, li) => ctx.fillText(ln, anchorH, y + 36 + li * SUM_LINE_H));
    }
    if (lines.away.length > 0) {
      ctx.textAlign = "left";
      lines.away.forEach((ln, li) => ctx.fillText(ln, anchorA, y + 36 + li * SUM_LINE_H));
    }
  }
  if (m.status === "live") {
    ctx.fillStyle = "#ff7a33";
    ctx.beginPath();
    ctx.arc(cx + pill / 2 + 10, y - 12, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFootBrand(ctx: CanvasRenderingContext2D, h: number): void {
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  font(ctx, 700, 26);
  ctx.fillText("WHL 赛事", 48, h - 64);
  font(ctx, 400, 14);
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.fillText("由 WHL 赛事系统生成", 48, h - 36);
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

// 赛事卡：封面打头（海报式），下方标题、信息、近期赛果/对阵预告
export async function drawTournamentCard(canvas: HTMLCanvasElement, data: TournamentCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 高度自适应：先算内容总高，再定画布，QR/脚注锚底
  const rowsStart = 480; // contentStart 434 + 46
  const list = data.matches.slice(0, 6);
  // 摘要按人折行：逐场预算行数，折行时行距加高
  const sums = list.map((m) => matchSummaryLines(ctx, m));
  const advances = sums.map((s) => 78 + Math.max(0, Math.max(s.home.length, s.away.length) - 1) * SUM_LINE_H);
  const contentEnd = list.length > 0 ? rowsStart + advances.reduce((a, b) => a + b, 0) - 42 : rowsStart;
  const H = Math.max(CARD_H, contentEnd + 240); // 240 ≥ QR 白板高 188，保证末行摘要与码不重叠
  canvas.height = H;
  drawBaseBg(ctx, H);

  const cs = await drawCoverHeader(ctx, data.coverUrl, data.name, data.subtitle, 240);
  sectionLabel(ctx, data.resultLabel, cs);
  let my = cs + 46;
  for (let i = 0; i < list.length; i++) {
    await drawMatchLine(ctx, list[i], my, sums[i]);
    my += advances[i];
  }
  if (list.length === 0) {
    font(ctx, 400, 18);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("比赛安排即将公布", 48, my);
  }
  drawFootBrand(ctx, H);
  await drawQr(ctx, data.url, H);
}

// 单场卡：封面打头 + 大比分 + 事件行
export async function drawMatchCard(canvas: HTMLCanvasElement, data: MatchCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const cs = 434; // 封面 240 的内容区起点
  const cy = cs + 106;
  // 同分钟同侧的相邻事件合并为一个节点（分钟只标一次，节点内各事件保序）；取前 10 个节点
  const groups: ShareEventRow[][] = [];
  for (const ev of data.eventRows ?? []) {
    const g = groups[groups.length - 1];
    if (g && g[0].minute === ev.minute && g[0].side === ev.side) g.push(ev);
    else groups.push([ev]);
  }
  const nodes = groups.slice(0, 10);
  // 节点布局：每事件一行 30px，有助攻的事件加一行 👟 20px，节点间 14px
  const EV_LINE_H = 30;
  const EV_ASSIST_H = 20;
  const NODE_GAP = 14;
  const nodeHeights = nodes.map((g) => g.reduce((h, ev) => h + EV_LINE_H + (ev.assistName ? EV_ASSIST_H : 0), 0));
  const totalH = nodeHeights.reduce((a, b) => a + b, 0) + (nodes.length - 1) * NODE_GAP;
  const rowsStart = cy + 150;
  const lastDotY = nodes.length > 0 ? rowsStart + totalH - NODE_GAP - nodeHeights[nodes.length - 1] / 2 : 0;
  const contentEnd = nodes.length > 0 ? lastDotY + 28 : cy + 70;
  const H = Math.max(CARD_H, contentEnd + 210);
  canvas.height = H;
  drawBaseBg(ctx, H);
  await drawCoverHeader(ctx, data.coverUrl, data.tournamentName, data.subtitle, 240);

  const m = data.match;
  const badge = 84;
  const cx = CARD_W / 2;

  ctx.textBaseline = "middle";
  // 长队名先缩号（最低 15px，10 个汉字可完整显示），缩到下限仍放不下才截断
  const nameMax = cx - 112 - badge - 8 - 36;
  const drawCardName = (name: string, x: number, align: CanvasTextAlign): number => {
    font(ctx, 700, 30);
    const w = ctx.measureText(name).width;
    if (w > nameMax) font(ctx, 700, Math.max(15, Math.floor((30 * nameMax) / w)));
    const shown = ctx.measureText(name).width > nameMax ? fitText(ctx, name, nameMax) : name;
    ctx.fillStyle = "#fff";
    ctx.textAlign = align;
    ctx.fillText(shown, x, cy);
    return ctx.measureText(shown).width;
  };

  const hw = drawCardName(m.home.name, cx - 112, "right");
  await drawTeamBadge(ctx, m.home, cx - 112 - hw - 8 - badge, cy - badge / 2, badge);

  const aw = drawCardName(m.away.name, cx + 112, "left");
  await drawTeamBadge(ctx, m.away, cx + 112 + aw + 8, cy - badge / 2, badge);

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
    ctx.fillText(fitText(ctx, m.note, CARD_W - 96), cx, cs + 26);
  }

  if (nodes.length > 0) {
    sectionLabel(ctx, "比赛事件", cy + 100);
    // 与页面 EventTimeline 同款链条式：中轴素色节点，主队信息向左、客队信息向右；
    // 合并节点分钟只标一次，助攻在所属球员行下一行
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(cx - 1, rowsStart - 14, 2, lastDotY - rowsStart + 28);
    ctx.textBaseline = "middle";
    let ny = rowsStart;
    for (let gi = 0; gi < nodes.length; gi++) {
      const nh = nodeHeights[gi];
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(cx, ny + nh / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      let ly = ny + EV_LINE_H / 2;
      nodes[gi].forEach((ev, ei) => {
        const min = ei === 0 && ev.minute != null ? ` ${ev.minute}′` : "";
        const who = ev.playerName ?? "";
        const tag = ev.tag ? `（${ev.tag}）` : "";
        const cardW = ev.card ? (ev.card === "red_2y" ? 18 : 11) + 6 : 0;
        const text = ev.card ? `${min} ${who}${tag}` : `${ev.icon}${min} ${who}${tag}`;
        font(ctx, 400, 17);
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        const maxW = cx - 80 - cardW;
        if (ev.side === "home") {
          ctx.textAlign = "right";
          const shown = fitText(ctx, text, maxW);
          const tw = ctx.measureText(shown).width;
          ctx.fillText(shown, cx - 32, ly);
          if (ev.card) drawCardMark(ctx, ev.card, cx - 32 - tw - cardW, ly);
        } else {
          ctx.textAlign = "left";
          const shown = fitText(ctx, text, maxW);
          ctx.fillText(shown, cx + 32 + cardW, ly);
          if (ev.card) drawCardMark(ctx, ev.card, cx + 32, ly);
        }
        ly += EV_LINE_H;
        if (ev.assistName) {
          font(ctx, 400, 13);
          ctx.fillStyle = "rgba(255,255,255,0.62)";
          if (ev.side === "home") {
            ctx.textAlign = "right";
            ctx.fillText(`👟 ${ev.assistName}`, cx - 32, ly);
          } else {
            ctx.textAlign = "left";
            ctx.fillText(`👟 ${ev.assistName}`, cx + 32, ly);
          }
          ly += EV_ASSIST_H;
        }
      });
      ny = ny + nh + NODE_GAP;
    }
  }
  drawFootBrand(ctx, H);
  await drawQr(ctx, data.url, H);
}

// 轮次卡：封面打头 + 该轮全部对阵
export async function drawRoundCard(canvas: HTMLCanvasElement, data: RoundCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rowsStart = 480; // contentStart 434 + 46
  const list = data.matches.slice(0, 12);
  const overflow = data.matches.length > list.length;
  // 摘要按人折行：逐场预算行数，折行时行距加高
  const sums = list.map((m) => matchSummaryLines(ctx, m));
  const advances = sums.map((s) => 78 + Math.max(0, Math.max(s.home.length, s.away.length) - 1) * SUM_LINE_H);
  const contentEnd =
    list.length > 0 ? rowsStart + advances.reduce((a, b) => a + b, 0) - 42 + (overflow ? 34 : 0) : rowsStart;
  const H = Math.max(CARD_H, contentEnd + 240); // 240 ≥ QR 白板高 188，保证末行摘要与码不重叠
  canvas.height = H;
  drawBaseBg(ctx, H);
  await drawCoverHeader(ctx, data.coverUrl, data.tournamentName, data.title, 240);

  sectionLabel(ctx, "本轮对阵", 434);
  let my = rowsStart;
  for (let i = 0; i < list.length; i++) {
    await drawMatchLine(ctx, list[i], my, sums[i]);
    my += advances[i];
  }
  if (list.length === 0) {
    font(ctx, 400, 18);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("本轮还没有安排比赛", 48, my);
  }
  if (overflow) {
    font(ctx, 400, 16);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.textAlign = "center";
    ctx.fillText(`还有 ${data.matches.length - list.length} 场未展示`, CARD_W / 2, my + 6);
  }
  drawFootBrand(ctx, H);
  await drawQr(ctx, data.url, H);
}

// 通用表卡：封面打头 + 积分榜 / 球员球队榜单共用
export async function drawTableCard(canvas: HTMLCanvasElement, data: TableCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const cs = 434; // 封面 240 的内容区起点（200 会把默认封面标题裁顶）
  const headerY = cs + 16;
  const headerH = 46;
  const rowH = 42;
  const rowsStart = headerY + headerH + 6;
  const rows = data.rows.slice(0, 20);
  const overflow = data.rows.length > rows.length;
  const zones = data.zones;
  const rowColors = zones?.rowColors ?? [];
  // 分隔线只跟随展示出来的行；strip 图例单行（名称区间并排）
  const shownDividers =
    zones?.style === "divider" ? zones.dividers.filter((d) => d.afterRow < rows.length) : [];
  const legend = zones?.style === "strip" ? zones.legend : [];
  const legendH = legend.length === 0 ? 0 : legend.length <= 5 ? 30 : 52;
  const dividerExtra = shownDividers.length * 16;
  const contentEnd =
    rowsStart + rows.length * rowH + (overflow ? 28 : 0) + dividerExtra + legendH;
  const H = Math.max(CARD_H, contentEnd + 210);
  canvas.height = H;
  drawBaseBg(ctx, H);
  await drawCoverHeader(ctx, data.coverUrl, data.tournamentName, data.title, 240);

  const x = 48;
  const w = CARD_W - 96;
  const weights = data.colWidths ?? data.columns.map(() => 1);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const colWs = weights.map((wt) => (wt / wsum) * w);
  let colAcc = x;
  const colLeft = colWs.map((cw) => {
    const l = colAcc;
    colAcc += cw;
    return l;
  });
  // 名称列左对齐（默认第 1 列），其余居中
  const rawName = data.nameCol ?? 1;
  const nameCols = new Set(Array.isArray(rawName) ? rawName : [rawName]);
  const cellX = (ci: number) => colLeft[ci] + (nameCols.has(ci) ? 16 : colWs[ci] / 2);

  // 表头
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  roundRectPath(ctx, x, headerY, w, headerH, 10);
  ctx.fill();
  font(ctx, 600, 16);
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.textBaseline = "middle";
  data.columns.forEach((c, i) => {
    ctx.textAlign = nameCols.has(i) ? "left" : "center";
    ctx.fillText(c, cellX(i), headerY + headerH / 2);
  });

  let ry = rowsStart;
  font(ctx, 500, 17);
  rows.forEach((row, ri) => {
    if (ri % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      roundRectPath(ctx, x, ry, w, rowH - 4, 8);
      ctx.fill();
    }
    // 排名段色条：行左缘 5px 圆角竖条（strip 样式）
    const zc = zones?.style === "strip" ? (rowColors[ri] ?? null) : null;
    if (zc) {
      ctx.fillStyle = zc;
      roundRectPath(ctx, x, ry, 5, rowH - 4, 3);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    row.forEach((cell, ci) => {
      ctx.textAlign = nameCols.has(ci) ? "left" : "center";
      ctx.fillText(fitText(ctx, cell, colWs[ci] - 12), cellX(ci), ry + (rowH - 4) / 2);
    });
    ry += rowH;
    // 区间分隔线：名次区间末行之后画线+线名（divider 样式）
    if (zones?.style === "divider") {
      for (const d of shownDividers) {
        if (d.afterRow !== ri) continue;
        ctx.fillStyle = d.color;
        ctx.fillRect(x, ry - 3, w, 3);
        font(ctx, 600, 12);
        const tw = ctx.measureText(d.name).width;
        const pw = tw + 14;
        ctx.fillStyle = d.color;
        roundRectPath(ctx, x + w - pw - 6, ry - 11, pw, 17, 8);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(d.name, x + w - pw + 1, ry - 2);
        ry += 16;
      }
    }
  });
  if (overflow) {
    font(ctx, 400, 14);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.textAlign = "center";
    ctx.fillText(`仅展示前 ${rows.length} 项，扫码看完整榜单`, CARD_W / 2, ry + 6);
    ry += 28;
  }
  if (legend.length > 0) {
    font(ctx, 500, 14);
    let lx = x;
    let ly = ry + 8;
    for (const item of legend) {
      const label = `${item.name}（${item.range}）`;
      const advance = 18 + ctx.measureText(label).width + 18;
      if (lx > x && lx + advance - 18 > x + w) {
        lx = x;
        ly += 22;
      }
      ctx.fillStyle = item.color;
      roundRectPath(ctx, lx, ly - 5, 12, 12, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 18, ly + 1);
      lx += advance;
    }
  }
  drawFootBrand(ctx, H);
  await drawQr(ctx, data.url, H);
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

// 新闻卡：头条对撞风格——kicker + 标题自动换行 + 大比分对阵 + 品牌底纹
export interface NewsCardData {
  kicker: string; // 「WHL 头版 · 半决赛」
  title: string;
  homeTeam?: string;
  awayTeam?: string;
  score?: string; // "2:0"
  url: string;
}

function wrapNewsTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (cur && ctx.measureText(cur + ch).width > maxWidth) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) {
        cur = "";
        break;
      }
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (cur) {
    // 没写完的尾巴挂到末行省略号
    lines[lines.length - 1] = lines[lines.length - 1] + "…";
  } else if (lines.length === maxLines && lines.join("").length < text.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.slice(0, -1) + "…";
  }
  return lines;
}

export async function drawNewsCard(canvas: HTMLCanvasElement, data: NewsCardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawBaseBg(ctx, CARD_H);

  font(ctx, 700, 26);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillText(data.kicker, 48, 118);

  font(ctx, 800, 44);
  ctx.fillStyle = "#ffffff";
  const lines = wrapNewsTitle(ctx, data.title, CARD_W - 96, 3);
  let y = 188;
  for (const ln of lines) {
    ctx.fillText(ln, 48, y);
    y += 58;
  }

  if (data.score) {
    ctx.textAlign = "center";
    font(ctx, 800, 110);
    ctx.fillText(data.score, CARD_W / 2, y + 140);
    font(ctx, 600, 32);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`${data.homeTeam ?? ""}  vs  ${data.awayTeam ?? ""}`, CARD_W / 2, y + 200);
    ctx.textAlign = "left";
  }

  drawFootBrand(ctx, CARD_H);
  await drawQr(ctx, data.url, CARD_H);
}
