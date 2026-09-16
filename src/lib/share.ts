import QRCode from "qrcode";
import whlLogoUrl from "../assets/whl-logo.png";

// 分享卡片绘制库：800×N 竖版 canvas，V7 定稿浅色纸面风（样式以 style-v7-full.png A'' 列为准）。
// 数据契约不动：drawXxxCard 签名、调用方传参、字段集合全不变（coverUrl 保留字段但头部不再用封面）。
// 队徽缺失时按队名 hash 取色画色块+首字（与 TeamLogo 组件同款色板）。

export const CARD_W = 800;

// V7 色板：纸底 + 墨字 + 橙强调
const INK = "#22211d";
const KICKER = "#c2410c";
const ACCENT = "#e8590c";
const BORDER = "#e0dccf";
const BG = "#faf8f2";
const ink = (a: number): string => `rgba(34,33,29,${a})`;

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
const LINE_PILL = 96;
const LINE_PILL_H = 48;
const LINE_GAP_PILL = 12;
const SUM_LINE_H = 34; // 摘要折行行距（23px 字号）
const MATCH_LINE_BASE = 100; // 单行摘要时对阵块占高
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
  font(ctx, 400, 23);
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

// 对阵块占高：核心行 + 摘要折行加高（drawMatchLine 与轮次/赛事卡共用同一公式）
function matchLineAdvance(s: { home: string[]; away: string[] }): number {
  return MATCH_LINE_BASE + Math.max(0, Math.max(s.home.length, s.away.length) - 1) * SUM_LINE_H;
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

// 单场卡事件链条几何常量（样稿 ×~2.1）：事件行 63、助攻行 42、节点间 29
const EV_LINE_H = 63;
const EV_ASSIST_H = 42;
const NODE_GAP = 29;

function colorOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function hexToRgba(hex: string, a: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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

/** 名称列自适应：优先整名放下（字号从 size 级进缩到 min），缩到底仍放不下才退回省略号 */
function fitNameCell(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, weight: number | string, size: number, min = 16): string {
  for (let s = size; s >= min; s -= 2) {
    font(ctx, weight, s);
    if (ctx.measureText(text).width <= maxWidth) return text;
  }
  font(ctx, weight, min);
  return fitText(ctx, text, maxWidth);
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

// 字距：Chrome/canvas 支持 letterSpacing；不支持时静默退化（仅少字距，不影响布局）
function setLetterSpacing(ctx: CanvasRenderingContext2D, px: string): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = px;
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

// 画卡底：纸色素底 + 圆角 14 裁切（PNG 四角透明）+ 1px 卡边
function drawBaseBg(ctx: CanvasRenderingContext2D, h: number): void {
  ctx.save();
  roundRectPath(ctx, 0, 0, CARD_W, h, 14);
  ctx.clip();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_W, h);
  ctx.restore();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  roundRectPath(ctx, 0.5, 0.5, CARD_W - 1, h - 1, 14);
  ctx.stroke();
}

// ---------- V7 头部（无封面）：品牌行 + 标题/副题 + 全宽橙条 ----------
const HEAD_X = 48;
const HEAD_TOP = 44;
const HEAD_BRAND_H = 40; // 徽标 40px
const HEAD_MAX_W = CARD_W - 96;

// 头部布局测量：仅由 title/subtitle 文本决定，供高度预算与绘制共用
function headerMetrics(ctx: CanvasRenderingContext2D, title: string, subtitle: string): number {
  font(ctx, 700, 44);
  const t = fitText(ctx, title, HEAD_MAX_W);
  const tw = ctx.measureText(t).width;
  font(ctx, 400, 28);
  const sw = subtitle ? ctx.measureText(`· ${subtitle}`).width : 0;
  const subOwnLine = subtitle !== "" && tw + 16 + sw > HEAD_MAX_W;
  const titleBaseline = HEAD_TOP + HEAD_BRAND_H + 16 + 36;
  const barY = subOwnLine ? titleBaseline + 48 + 28 + 26 : titleBaseline + 30;
  return barY + 4 + 40; // 内容区起始 y（橙条下留 40 呼吸）
}

// 头部绘制：品牌行（徽标 40px + WHL 联赛 700/22 字距 4，加载失败只出文字）
// + 标题 INK 700/44 + 副题 400/28（放得下同行，放不下换行）+ 全宽 4px 橙条。返回内容区起始 y。
async function drawHeader(ctx: CanvasRenderingContext2D, title: string, subtitle: string): Promise<number> {
  let y = HEAD_TOP;
  const logo = await loadImg(whlLogoUrl);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let tx = HEAD_X;
  if (logo) {
    const s = 40 / Math.max(logo.width, logo.height);
    const dw = logo.width * s;
    const dh = logo.height * s;
    ctx.drawImage(logo, HEAD_X, y + (40 - dh) / 2, dw, dh);
    tx = HEAD_X + 40 + 12;
  }
  ctx.fillStyle = KICKER;
  font(ctx, 700, 22);
  setLetterSpacing(ctx, "4px");
  ctx.fillText("WHL 联赛", tx, y + 21);
  setLetterSpacing(ctx, "0px");

  const titleBaseline = y + HEAD_BRAND_H + 16 + 36;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  font(ctx, 700, 44);
  const shown = fitText(ctx, title, HEAD_MAX_W);
  const titleW = ctx.measureText(shown).width;
  ctx.fillText(shown, HEAD_X, titleBaseline);
  let subOwnLine = false;
  if (subtitle) {
    font(ctx, 400, 28);
    const sub = `· ${subtitle}`;
    if (titleW + 16 + ctx.measureText(sub).width <= HEAD_MAX_W) {
      ctx.fillStyle = ink(0.6);
      ctx.fillText(sub, HEAD_X + titleW + 16, titleBaseline);
    } else {
      subOwnLine = true;
      const subBaseline = titleBaseline + 48 + 28;
      ctx.fillStyle = ink(0.6);
      ctx.fillText(fitText(ctx, subtitle, HEAD_MAX_W), HEAD_X, subBaseline);
    }
  }
  const barY = titleBaseline + (subOwnLine ? 102 : 30);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, barY, CARD_W, 4);
  return barY + 4 + 40;
}

// QR：白板 168px + 1px 边框（可扫性优先）；码色深绿 #12241b
// 页脚（V7 口径）：左一行小字（图例或「{tournamentName} · WHL」）+ 右 84px 棕橙真码 chip
const CHIP = 84;
const FOOT_GAP = 40; // 内容末行与页脚行间隙
const FOOT_BOTTOM = 27;
const FOOT_H = FOOT_GAP + CHIP + FOOT_BOTTOM;
const CHIP_BG = "#9a3412";
const CHIP_FG = "#faf8f2";
const MIN_H = 760;

function chipX(): number {
  return CARD_W - CHIP - 34;
}

function drawFootText(ctx: CanvasRenderingContext2D, text: string, h: number): void {
  font(ctx, 500, 22);
  ctx.fillStyle = "#8a877c";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, text, chipX() - HEAD_X - 24), HEAD_X, h - FOOT_BOTTOM - CHIP / 2);
}

function drawFootLegend(
  ctx: CanvasRenderingContext2D,
  legend: { color: string; name: string; range: string }[],
  h: number,
): void {
  const cy = h - FOOT_BOTTOM - CHIP / 2;
  const maxRight = chipX() - 24;
  font(ctx, 500, 20);
  let lx = HEAD_X;
  for (const item of legend) {
    const label = `${item.name}（${item.range}）`;
    const adv = 26 + ctx.measureText(label).width + 18;
    if (lx + adv > maxRight && lx > HEAD_X) break;
    ctx.fillStyle = item.color;
    roundRectPath(ctx, lx, cy - 9, 18, 18, 5);
    ctx.fill();
    ctx.fillStyle = ink(0.6);
    ctx.textAlign = "left";
    ctx.fillText(label, lx + 26, cy + 1);
    lx += adv;
  }
}

async function drawQrChip(ctx: CanvasRenderingContext2D, url: string, h: number): Promise<void> {
  const x = chipX();
  const y = h - FOOT_BOTTOM - CHIP;
  ctx.fillStyle = CHIP_BG;
  roundRectPath(ctx, x, y, CHIP, CHIP, 15);
  ctx.fill();
  // 真码：浅米色模块画在棕底上，chip 自身边缘充当静区
  const off = document.createElement("canvas");
  await QRCode.toCanvas(off, url, {
    width: CHIP - 18,
    margin: 0,
    color: { dark: CHIP_FG, light: CHIP_BG },
  });
  ctx.drawImage(off, x + 9, y + 9);
}

function sectionLabel(ctx: CanvasRenderingContext2D, text: string, y: number): void {
  font(ctx, 600, 22);
  ctx.fillStyle = KICKER;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  setLetterSpacing(ctx, "2px");
  ctx.fillText(text, HEAD_X, y);
  setLetterSpacing(ctx, "0px");
}

// 浅虚线分隔（对阵块之间）
function dashedSeparator(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.save();
  ctx.strokeStyle = ink(0.16);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 8]);
  ctx.beginPath();
  ctx.moveTo(HEAD_X, y);
  ctx.lineTo(CARD_W - HEAD_X, y);
  ctx.stroke();
  ctx.restore();
}

// 一行对阵：队名 700/28+徽标、中央胶囊、比分/点球/事件摘要（主右客左、各队事件在自己队名下方）
async function drawMatchLine(
  ctx: CanvasRenderingContext2D,
  m: ShareMatch,
  y: number,
  lines: { home: string[]; away: string[] },
): Promise<void> {
  const cx = CARD_W / 2;
  const badge = 36;
  const pill = LINE_PILL;
  const pillH = LINE_PILL_H;
  const gapPill = LINE_GAP_PILL; // 文字与胶囊的间隙
  const gapBadge = 8; // 文字与徽标的间隙
  font(ctx, 700, 28);

  // 文字锚点在胶囊外侧，徽标再往外；保证最长文字（fitText 截断后）也不碰胶囊、不越边距
  const anchorH = cx - pill / 2 - gapPill;
  const anchorA = cx + pill / 2 + gapPill;
  const textMax = anchorH - HEAD_X - badge - gapBadge;

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const homeName = fitText(ctx, m.home.name, textMax);
  ctx.fillStyle = INK;
  ctx.fillText(homeName, anchorH, y);
  const hw = ctx.measureText(homeName).width;
  await drawTeamBadge(ctx, m.home, anchorH - hw - gapBadge - badge, y - badge / 2, badge);

  ctx.textAlign = "left";
  const awayName = fitText(ctx, m.away.name, textMax);
  ctx.fillStyle = INK;
  ctx.fillText(awayName, anchorA, y);
  const aw = ctx.measureText(awayName).width;
  await drawTeamBadge(ctx, m.away, anchorA + aw + gapBadge, y - badge / 2, badge);

  // 中央胶囊
  ctx.fillStyle = ink(0.08);
  roundRectPath(ctx, cx - pill / 2, y - pillH / 2, pill, pillH, pillH / 2);
  ctx.fill();
  ctx.textAlign = "center";
  if (m.status === "finished") {
    font(ctx, 700, 22);
    ctx.fillStyle = INK;
    ctx.fillText(`${m.scoreHome ?? 0} : ${m.scoreAway ?? 0}`, cx, y + 1);
  } else if (m.status === "live") {
    font(ctx, 700, 22);
    ctx.fillStyle = ACCENT;
    ctx.fillText(`${m.scoreHome ?? 0} : ${m.scoreAway ?? 0}`, cx, y + 1);
  } else {
    font(ctx, 600, 18);
    ctx.fillStyle = ink(0.45);
    ctx.fillText("vs", cx, y + 1);
  }
  const subY = y + pillH / 2 + 20; // 胶囊下方副注/摘要首行
  if (m.status === "finished" && (m.penHome != null || m.penAway != null)) {
    font(ctx, 400, 23);
    ctx.fillStyle = ink(0.6);
    ctx.textBaseline = "middle";
    ctx.fillText(`点球 ${m.penHome} : ${m.penAway}`, cx, subY);
  }
  // 事件摘要：主侧贴胶囊左侧右对齐、客侧贴胶囊右侧左对齐，与点球括注同排（水平错开）；
  // 名单放不下时按人折行（行距 SUM_LINE_H），行数组由调用方预算传入
  if (lines.home.length > 0 || lines.away.length > 0) {
    font(ctx, 400, 23);
    ctx.fillStyle = ink(0.72);
    ctx.textBaseline = "middle";
    if (lines.home.length > 0) {
      ctx.textAlign = "right";
      lines.home.forEach((ln, li) => ctx.fillText(ln, anchorH, subY + li * SUM_LINE_H));
    }
    if (lines.away.length > 0) {
      ctx.textAlign = "left";
      lines.away.forEach((ln, li) => ctx.fillText(ln, anchorA, subY + li * SUM_LINE_H));
    }
  }
  if (m.status === "live") {
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(cx + pill / 2 + 12, y - 14, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 赛事总览卡：区标 + 近期赛果/对阵预告（最多 6 场）
export async function drawTournamentCard(canvas: HTMLCanvasElement, data: TournamentCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 高度自适应：先算内容总高，再定画布，QR/脚注锚底
  const rowsStart = headerMetrics(ctx, data.name, data.subtitle) + 46;
  const list = data.matches.slice(0, 6);
  const sums = list.map((m) => matchSummaryLines(ctx, m));
  const contentEnd =
    list.length > 0
      ? rowsStart + sums.reduce((a, s) => a + matchLineAdvance(s), 0) - 56
      : rowsStart + 8;
  const H = Math.max(MIN_H, contentEnd + FOOT_H); // 页脚 = 间隙 40 + chip 84 + 底边 27
  canvas.height = H;
  drawBaseBg(ctx, H);

  const cs = await drawHeader(ctx, data.name, data.subtitle);
  sectionLabel(ctx, data.resultLabel, cs + 14);
  let my = rowsStart;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) dashedSeparator(ctx, my - 36);
    await drawMatchLine(ctx, list[i], my, sums[i]);
    my += matchLineAdvance(sums[i]);
  }
  if (list.length === 0) {
    font(ctx, 400, 24);
    ctx.fillStyle = ink(0.5);
    ctx.fillText("比赛安排即将公布", HEAD_X, my + 10);
  }
  drawFootText(ctx, `${data.name} · WHL`, H);
  await drawQrChip(ctx, data.url, H);
}

// 单场卡：大比分区 + 「比赛事件」链条
export async function drawMatchCard(canvas: HTMLCanvasElement, data: MatchCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 同分钟同侧的相邻事件合并为一个节点（分钟只标一次，节点内各事件保序）；取前 10 个节点
  const groups: ShareEventRow[][] = [];
  for (const ev of data.eventRows ?? []) {
    const g = groups[groups.length - 1];
    if (g && g[0].minute === ev.minute && g[0].side === ev.side) g.push(ev);
    else groups.push([ev]);
  }
  const nodes = groups.slice(0, 10);
  const nodeHeights = nodes.map((g) =>
    g.reduce((h, ev) => h + EV_LINE_H + (ev.assistName ? EV_ASSIST_H : 0), 0),
  );
  const totalH = nodeHeights.reduce((a, b) => a + b, 0) + Math.max(0, nodes.length - 1) * NODE_GAP;

  const cs0 = headerMetrics(ctx, data.tournamentName, data.subtitle);
  const cy = cs0 + 120; // 大比分行中轴
  const rowsStart = cy + 140; // 事件链条起始
  const contentEnd = nodes.length > 0 ? rowsStart + totalH : cy + 110;
  const H = Math.max(MIN_H, contentEnd + FOOT_H);
  canvas.height = H;
  drawBaseBg(ctx, H);
  const cs = await drawHeader(ctx, data.tournamentName, data.subtitle);

  const m = data.match;
  const badge = 72;
  const cx = CARD_W / 2;

  ctx.textBaseline = "middle";
  // 长队名先缩号（最低 17px），缩到下限仍放不下才截断
  const nameMax = cx - 104 - badge - 8 - 32;
  const drawCardName = (name: string, x: number, align: CanvasTextAlign): number => {
    font(ctx, 700, 32);
    const w = ctx.measureText(name).width;
    if (w > nameMax) font(ctx, 700, Math.max(16, Math.floor((32 * nameMax) / w)));
    const shown = ctx.measureText(name).width > nameMax ? fitText(ctx, name, nameMax) : name;
    ctx.fillStyle = INK;
    ctx.textAlign = align;
    ctx.fillText(shown, x, cy);
    return ctx.measureText(shown).width;
  };

  const hw = drawCardName(m.home.name, cx - 104, "right");
  await drawTeamBadge(ctx, m.home, cx - 104 - hw - 8 - badge, cy - badge / 2, badge);

  const aw = drawCardName(m.away.name, cx + 104, "left");
  await drawTeamBadge(ctx, m.away, cx + 104 + aw + 8, cy - badge / 2, badge);

  ctx.textAlign = "center";
  if (m.status === "pending") {
    font(ctx, 700, 64);
    ctx.fillStyle = ink(0.35);
    ctx.fillText("vs", cx, cy);
    font(ctx, 400, 22);
    ctx.fillStyle = ink(0.5);
    ctx.fillText("未开打", cx, cy + 58);
  } else {
    font(ctx, 700, 72);
    ctx.fillStyle = m.status === "live" ? ACCENT : INK;
    ctx.fillText(`${m.scoreHome ?? 0} : ${m.scoreAway ?? 0}`, cx, cy);
    if (m.penHome != null || m.penAway != null) {
      font(ctx, 400, 23);
      ctx.fillStyle = ink(0.6);
      ctx.fillText(`点球 ${m.penHome} : ${m.penAway}`, cx, cy + 58);
    }
    if (m.status === "live") {
      font(ctx, 600, 22);
      ctx.fillStyle = ACCENT;
      ctx.fillText("● 进行中", cx, cy + 58);
    }
  }
  if (m.note) {
    font(ctx, 400, 20);
    ctx.fillStyle = ink(0.5);
    ctx.fillText(fitText(ctx, m.note, CARD_W - 96), cx, cs + 22);
  }

  if (nodes.length > 0) {
    sectionLabel(ctx, "比赛事件", cy + 104);
    // 与页面 EventTimeline 同款链条式：中轴细线，主队信息向左、客队信息向右；
    // 合并节点分钟胶囊贴中轴、只标一次（对齐节点首行），助攻行向外侧缩进 50px
    ctx.fillStyle = ink(0.15);
    ctx.fillRect(cx - 1, rowsStart - 12, 2, totalH + 24);
    ctx.textBaseline = "middle";
    let ny = rowsStart;
    for (let gi = 0; gi < nodes.length; gi++) {
      const firstMin = nodes[gi][0].minute;
      if (firstMin != null) {
        const label = `${firstMin}′`;
        font(ctx, 600, 20);
        const pw = ctx.measureText(label).width + 28;
        ctx.fillStyle = ink(0.08);
        roundRectPath(ctx, cx - pw / 2, ny + EV_LINE_H / 2 - 18, pw, 36, 18);
        ctx.fill();
        ctx.fillStyle = INK;
        ctx.textAlign = "center";
        ctx.fillText(label, cx, ny + EV_LINE_H / 2 + 1);
      }
      let ly = ny + EV_LINE_H / 2;
      nodes[gi].forEach((ev) => {
        // 分钟只在轴上胶囊出现一次（样稿口径），事件行文本不再重复分钟
        const who = ev.playerName ?? "";
        const tag = ev.tag ? `（${ev.tag}）` : "";
        const cardW = ev.card ? (ev.card === "red_2y" ? 18 : 11) + 6 : 0;
        const text = ev.card ? `${who}${tag}` : `${ev.icon} ${who}${tag}`;
        font(ctx, 400, 26);
        const maxW = cx - 88 - cardW;
        if (ev.side === "home") {
          ctx.textAlign = "right";
          const shown = fitText(ctx, text, maxW);
          const tw = ctx.measureText(shown).width;
          ctx.fillStyle = INK;
          ctx.fillText(shown, cx - 56, ly);
          if (ev.card) drawCardMark(ctx, ev.card, cx - 56 - tw - cardW, ly);
        } else {
          ctx.textAlign = "left";
          const shown = fitText(ctx, text, maxW);
          ctx.fillStyle = INK;
          ctx.fillText(shown, cx + 56 + cardW, ly);
          if (ev.card) drawCardMark(ctx, ev.card, cx + 56, ly);
        }
        ly += EV_LINE_H;
        if (ev.assistName) {
          font(ctx, 400, 23);
          ctx.fillStyle = ink(0.6);
          if (ev.side === "home") {
            ctx.textAlign = "right";
            ctx.fillText(`👟 ${ev.assistName}`, cx - 106, ly);
          } else {
            ctx.textAlign = "left";
            ctx.fillText(`👟 ${ev.assistName}`, cx + 106, ly);
          }
          ly += EV_ASSIST_H;
        }
      });
      ny = ny + nodeHeights[gi] + NODE_GAP;
    }
  }
  drawFootText(ctx, `${data.tournamentName} · WHL`, H);
  await drawQrChip(ctx, data.url, H);
}

// 轮次卡：该轮全部对阵（最多 12 场）+ 块间浅虚线 + 溢出提示
export async function drawRoundCard(canvas: HTMLCanvasElement, data: RoundCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rowsStart = headerMetrics(ctx, data.tournamentName, data.title) + 16;
  const list = data.matches.slice(0, 12);
  const overflow = data.matches.length > list.length;
  const sums = list.map((m) => matchSummaryLines(ctx, m));
  const contentEnd =
    list.length > 0
      ? rowsStart + sums.reduce((a, s) => a + matchLineAdvance(s), 0) - 56 + (overflow ? 46 : 0)
      : rowsStart + 8;
  const H = Math.max(MIN_H, contentEnd + FOOT_H); // 页脚 = 间隙 40 + chip 84 + 底边 27
  canvas.height = H;
  drawBaseBg(ctx, H);
  await drawHeader(ctx, data.tournamentName, data.title);

  let my = rowsStart;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) dashedSeparator(ctx, my - 36);
    await drawMatchLine(ctx, list[i], my, sums[i]);
    my += matchLineAdvance(sums[i]);
  }
  if (list.length === 0) {
    font(ctx, 400, 24);
    ctx.fillStyle = ink(0.5);
    ctx.fillText("本轮还没有安排比赛", HEAD_X, my + 10);
  }
  if (overflow) {
    font(ctx, 400, 20);
    ctx.fillStyle = ink(0.5);
    ctx.textAlign = "center";
    ctx.fillText(`还有 ${data.matches.length - list.length} 场未展示`, CARD_W / 2, my + 4);
    ctx.textAlign = "left";
  }
  drawFootText(ctx, `${data.tournamentName} · WHL`, H);
  await drawQrChip(ctx, data.url, H);
}

// 通用表卡：积分榜 / 球员球队榜单共用
export async function drawTableCard(canvas: HTMLCanvasElement, data: TableCardData): Promise<void> {
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rowH = 64;
  // 行上限 40（原来 20 截掉了大组积分榜；画布高度随行数自适应，扫码兜底仍留）
  const rows = data.rows.slice(0, 40);
  const overflow = data.rows.length > rows.length;
  const zones = data.zones;
  const rowColors = zones?.rowColors ?? [];
  // 分隔线只跟随展示出来的行；strip 图例单行（名称区间并排）
  const shownDividers =
    zones?.style === "divider" ? zones.dividers.filter((d) => d.afterRow < rows.length) : [];
  const legend = zones?.style === "strip" ? zones.legend : [];
  const dividerExtra = shownDividers.length * 26;
  const rowsStart = headerMetrics(ctx, data.tournamentName, data.title) + 22;
  const contentEnd =
    rowsStart + rows.length * rowH + (overflow ? 44 : 0) + dividerExtra;
  const H = Math.max(MIN_H, contentEnd + FOOT_H);
  canvas.height = H;
  drawBaseBg(ctx, H);
  await drawHeader(ctx, data.tournamentName, data.title);

  const x = HEAD_X;
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

  // 表头：素灰 600/22 无底罩
  font(ctx, 600, 22);
  ctx.fillStyle = ink(0.6);
  ctx.textBaseline = "middle";
  data.columns.forEach((c, i) => {
    ctx.textAlign = nameCols.has(i) ? "left" : "center";
    ctx.fillText(c, cellX(i), rowsStart - 22);
  });

  let ry = rowsStart;
  rows.forEach((row, ri) => {
    const zc = zones?.style === "strip" ? (rowColors[ri] ?? null) : null;
    if (zc) {
      // strip：整行 tint（全出血）+ 左缘 4px 色条
      ctx.fillStyle = hexToRgba(zc, 0.09);
      ctx.fillRect(0, ry, CARD_W, rowH);
      ctx.fillStyle = zc;
      ctx.fillRect(0, ry, 4, rowH);
    }
    ctx.textBaseline = "middle";
    row.forEach((cell, ci) => {
      ctx.textAlign = nameCols.has(ci) ? "left" : "center";
      const last = ci === row.length - 1;
      if (last) font(ctx, 800, 28);
      else if (nameCols.has(ci)) font(ctx, 700, 26);
      else font(ctx, 400, 24);
      // 名称列可向右借居中数字列的留白（数值短居中，两侧余量大），长队名少截断
      const maxCell = nameCols.has(ci) ? colWs[ci] - 16 + 28 : colWs[ci] - 16;
      ctx.fillStyle =
        zc && (ci === 0 || nameCols.has(ci)) ? zc : last ? INK : ink(0.85);
      if (nameCols.has(ci)) {
        // 名称列：整名优先（字号缩档），极端长名才省略号（用户反馈 Sergej Milinković-Savić 类）
        ctx.fillText(fitNameCell(ctx, cell, maxCell, 700, 26), cellX(ci), ry + rowH / 2 + 1);
      } else {
        ctx.fillText(fitText(ctx, cell, maxCell), cellX(ci), ry + rowH / 2 + 1);
      }
    });
    ry += rowH;
    // 行底 1px 细线（无斑马纹）
    ctx.fillStyle = BORDER;
    ctx.fillRect(0, ry - 1, CARD_W, 1);
    // 区间分隔线：名次区间末行之后画线+右侧标签 chip（divider 样式）
    if (zones?.style === "divider") {
      for (const d of shownDividers) {
        if (d.afterRow !== ri) continue;
        ctx.fillStyle = d.color;
        ctx.fillRect(x, ry + 12, w, 2);
        font(ctx, 600, 18);
        const tw = ctx.measureText(d.name).width;
        const pw = tw + 20;
        roundRectPath(ctx, x + w - pw, ry + 1, pw, 25, 12);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(d.name, x + w - pw + 10, ry + 14);
        ry += 26;
      }
    }
  });
  if (overflow) {
    font(ctx, 400, 20);
    ctx.fillStyle = ink(0.5);
    ctx.textAlign = "center";
    ctx.fillText(`仅展示前 ${rows.length} 项，扫码看完整榜单`, CARD_W / 2, ry + 12);
    ctx.textAlign = "left";
    ry += 44;
  }
  if (legend.length > 0) drawFootLegend(ctx, legend, H);
  else drawFootText(ctx, `${data.tournamentName} · WHL`, H);
  await drawQrChip(ctx, data.url, H);
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
  tournamentName?: string; // 页脚左字，缺省用「WHL 头版」
  url: string;
}

// 暗纹方案（新闻卡专用，卡面素底太光的点缀）
export type NewsTexture = "none" | "dots" | "stripes" | "wm" | "pitch";

const NEWS_TEXTURES: NewsTexture[] = ["dots", "stripes", "wm", "pitch"];

async function drawNewsTexture(
  ctx: CanvasRenderingContext2D,
  h: number,
  kind: NewsTexture,
): Promise<void> {
  if (kind === "none") return;
  ctx.save();
  roundRectPath(ctx, 0, 0, CARD_W, h, 14);
  ctx.clip();
  if (kind === "dots") {
    // 细点阵：错排两行 halftone，印刷网点质感
    ctx.fillStyle = ink(0.05);
    const gap = 48;
    for (let gy = 40; gy < h - 30; gy += gap) {
      const off = (Math.round(gy / gap) % 2) * (gap / 2);
      for (let gx = 40 + off; gx < CARD_W - 20; gx += gap) {
        ctx.beginPath();
        ctx.arc(gx, gy, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (kind === "stripes") {
    // 45° 斜细纹
    ctx.strokeStyle = ink(0.035);
    ctx.lineWidth = 3;
    for (let d = -h; d < CARD_W + h; d += 36) {
      ctx.beginPath();
      ctx.moveTo(d, 0);
      ctx.lineTo(d + h, h);
      ctx.stroke();
    }
  } else if (kind === "wm") {
    // WHL 徽标线稿水印：灰度后 Sobel 描边成线稿，墨色细线压右下角
    const img = await loadImg(whlLogoUrl);
    if (img) {
      const size = 420;
      const ratio = 372 / img.width;
      const off = document.createElement("canvas");
      off.width = img.width;
      off.height = img.height;
      const octx = off.getContext("2d");
      if (octx) {
        // 裁掉徽标底部自带的奶色 swoosh 底纹（y≥373），线稿化后视觉上像噪点
        const cut = 372;
        off.width = img.width;
        off.height = cut;
        octx.drawImage(img, 0, 0, img.width, cut, 0, 0, img.width, cut);
        const src = octx.getImageData(0, 0, off.width, off.height);
        const n = src.width * src.height;
        // 亮度×透明度作灰度场（透明处趋白）
        const g = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const a = src.data[i * 4 + 3] / 255;
          const lum =
            (0.299 * src.data[i * 4] + 0.587 * src.data[i * 4 + 1] + 0.114 * src.data[i * 4 + 2]) /
            255;
          g[i] = lum * a + (1 - a);
        }
        const out = octx.createImageData(src.width, src.height);
        const E = new Float32Array(n);
        for (let y = 1; y < src.height - 1; y++) {
          for (let x = 1; x < src.width - 1; x++) {
            const i = y * src.width + x;
            const gx =
              g[i - src.width - 1] + 2 * g[i - 1] + g[i + src.width - 1] -
              (g[i - src.width + 1] + 2 * g[i + 1] + g[i + src.width + 1]);
            const gy =
              g[i - src.width - 1] + 2 * g[i - src.width] + g[i - src.width + 1] -
              (g[i + src.width - 1] + 2 * g[i + src.width] + g[i + src.width + 1]);
            const mag = Math.hypot(gx, gy);
            E[i] = mag > 0.38 ? mag : 0;
          }
        }
        // 去孤立噪点：8 邻域内不足 2 个边像素的边剔除（跑两轮，收掉小噪簇）
        for (let pass = 0; pass < 2; pass++) {
          for (let y = 1; y < src.height - 1; y++) {
            for (let x = 1; x < src.width - 1; x++) {
              const i = y * src.width + x;
              if (E[i] === 0) continue;
              let c = 0;
              for (const d of [-src.width - 1, -src.width, -src.width + 1, -1, 1, src.width - 1, src.width, src.width + 1]) {
                if (E[i + d] > 0) c++;
              }
              if (c < 2) E[i] = 0;
            }
          }
        }
        // 连通域面积过滤：不足 6px 的边组件是噪块，整体剔除
        {
          const seen = new Uint8Array(n);
          const comp: number[] = [];
          for (let i0 = 0; i0 < n; i0++) {
            if (E[i0] === 0 || seen[i0]) continue;
            comp.length = 0;
            comp.push(i0);
            seen[i0] = 1;
            let head = 0;
            while (head < comp.length) {
              const i = comp[head++];
              for (const d of [-src.width - 1, -src.width, -src.width + 1, -1, 1, src.width - 1, src.width, src.width + 1]) {
                if (E[i + d] > 0 && !seen[i + d]) {
                  seen[i + d] = 1;
                  comp.push(i + d);
                }
              }
            }
            if (comp.length < 6) for (const i of comp) E[i] = 0;
          }
        }
        // flood-fill：从画布四边漫过非边像素，没被漫到的封闭区是形状内部 → 极浅填充
        const outside = new Uint8Array(n);
        const stack: number[] = [];
        for (let x = 0; x < src.width; x++) {
          stack.push(x, (src.height - 1) * src.width + x);
        }
        for (let y = 0; y < src.height; y++) {
          stack.push(y * src.width, y * src.width + src.width - 1);
        }
        while (stack.length > 0) {
          const i = stack.pop() as number;
          if (outside[i] || E[i] > 0) continue;
          outside[i] = 1;
          const x = i % src.width;
          if (x > 0) stack.push(i - 1);
          if (x < src.width - 1) stack.push(i + 1);
          if (i >= src.width) stack.push(i - src.width);
          if (i < n - src.width) stack.push(i + src.width);
        }
        for (let i = 0; i < n; i++) {
          if (E[i] > 0) {
            out.data[i * 4] = 34;
            out.data[i * 4 + 1] = 33;
            out.data[i * 4 + 2] = 29;
            out.data[i * 4 + 3] = Math.min(255, E[i] * 400);
          } else if (!outside[i]) {
            out.data[i * 4] = 34;
            out.data[i * 4 + 1] = 33;
            out.data[i * 4 + 2] = 29;
            out.data[i * 4 + 3] = 30; // 内部极浅填充
          }
        }
        octx.putImageData(out, 0, 0);
        ctx.globalAlpha = 0.3;
        ctx.drawImage(off, CARD_W - size - 30, h - size * ratio - 40, size, size * ratio);
        ctx.globalAlpha = 1;
      }
    }
  } else if (kind === "pitch") {
    // 球场线稿：大圆 + 中线 + 中圈
    ctx.strokeStyle = ink(0.05);
    ctx.lineWidth = 2;
    const cx = CARD_W / 2;
    const cy = h / 2 + 70;
    ctx.beginPath();
    ctx.arc(cx, cy, 250, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 90, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(CARD_W, cy);
    ctx.stroke();
  }
  ctx.restore();
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

export async function drawNewsCard(
  canvas: HTMLCanvasElement,
  data: NewsCardData,
  texture?: NewsTexture,
): Promise<void> {
  // 未指定暗纹时四选一随机（dots/stripes/wm/pitch）
  const tex: NewsTexture = texture ?? NEWS_TEXTURES[Math.floor(Math.random() * NEWS_TEXTURES.length)];
  // 先量内容定高（content-hugging），再铺底/暗纹
  canvas.width = CARD_W;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  font(ctx, 800, 44);
  const lines = wrapNewsTitle(ctx, data.title, CARD_W - 96, 3);
  const yAfterTitle = 188 + lines.length * 58;
  const contentEnd = data.score ? yAfterTitle + 226 : yAfterTitle - 30;
  const H = Math.max(MIN_H, contentEnd + FOOT_H);
  canvas.height = H;
  drawBaseBg(ctx, H);
  await drawNewsTexture(ctx, H, tex);

  font(ctx, 700, 26);
  ctx.fillStyle = ACCENT;
  ctx.textBaseline = "alphabetic";
  setLetterSpacing(ctx, "3px");
  ctx.fillText(data.kicker, HEAD_X, 118);
  setLetterSpacing(ctx, "0px");

  font(ctx, 800, 44);
  ctx.fillStyle = INK;
  let y = 188;
  for (const ln of lines) {
    ctx.fillText(ln, HEAD_X, y);
    y += 58;
  }

  if (data.score) {
    ctx.textAlign = "center";
    font(ctx, 800, 110);
    ctx.fillStyle = INK;
    ctx.fillText(data.score, CARD_W / 2, y + 140);
    font(ctx, 600, 32);
    ctx.fillStyle = ink(0.75);
    ctx.fillText(`${data.homeTeam ?? ""}  vs  ${data.awayTeam ?? ""}`, CARD_W / 2, y + 200);
    ctx.textAlign = "left";
  }

  drawFootText(ctx, `${data.tournamentName ?? "WHL 头版"} · WHL`, H);
  await drawQrChip(ctx, data.url, H);
}
