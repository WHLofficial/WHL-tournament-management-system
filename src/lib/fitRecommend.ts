// 一键推荐（B2 计划 S2 / spec §5.3）、阵型对比（S3 / spec §5.4）与替补角色化（S4 / §5.5）
// 的纯逻辑半：候选池选取、diff 行构造、全阵型对比行构造、替补「擅长槽位」top3 截取。
// 「怎么算分」在 shared/fitScore（B1 引擎，不在这里重算），「怎么挑人」在 shared/optimalXI
// （匈牙利算法）；本文件的函数均与 React 无关、可单测（tests/fitRecommend.test.ts）：
// ① fitRecPool：从全队圈出可参与推荐的 pid（排除停赛/伤停 + 无 meta），不足 11 人放开全员；
// ② fitDiffRows：把 optimalXI 的分配结果对上现任首发草稿，铺成逐槽 diff 行（出/入/保持）；
// ③ fitCompareRows：全部阵型各跑一次 optimalXI，按最优分配后的全队总分排序（短板明细随行）；
// ④ fitBenchTopTags：替补槽的「擅长 ST|AF 92 · …」——个人内 fitTile 降序 top3，值为该槽 rankShown。
import { optimalXI } from "../../shared/optimalXI";
import { fitTile, type FitGroup, type FitProfile } from "../../shared/fitScore";

export interface FitRecPool {
  /** 进候选池的 pid（互异） */
  pids: number[];
  /** 排除停赛/伤停后不足 11 人 → 放开全员（含停赛/伤停），true 时调用方附一句提示 */
  widened: boolean;
}

/**
 * 候选池选取：先按 isAvailable（非停赛/伤停，口径由调用方注入——战术页传 statOfPid 的判定）
 * 过滤，不足 minSlots 人放开为全员；无 FC26 数据（hasMeta = false）任何时候都不进池
 * （推荐不猜无数据的人，meta 过滤在放开之后仍然生效）。纯函数，不动输入。
 */
export function fitRecPool(
  players: readonly { id: number }[],
  isAvailable: (pid: number) => boolean,
  hasMeta: (pid: number) => boolean,
  minSlots = 11,
): FitRecPool {
  const available = players.filter((p) => isAvailable(p.id));
  const widened = available.length < minSlots;
  return {
    pids: (widened ? players : available)
      .filter((p) => hasMeta(p.id))
      .map((p) => p.id),
    widened,
  };
}

export interface FitDiffSlot {
  lid: number;
  position: string;
  /** 槽位键（"ST|AF"，与 ROLE_FIT / fitProfileAll 同键）；FIT 权重与展示都用它 */
  slotKey: string;
}

/** diff 行三分支：out = 现任被换下（现任可能无 meta，其 FIT 为 null）；in = 空槽进人；
 *  keep = 推荐与现任相同（含该槽无人可推荐、照旧摆现任的情况） */
export interface FitDiffRow {
  lid: number;
  position: string;
  kind: "out" | "in" | "keep";
  curPid: number | null;
  newPid: number | null;
  /** FIT 显示口径 rankShown（同候选面板行首，spec §4.2 ②：封顶只压显示不压排序）；
   *  无 meta / 该槽 6 键全缺为 null */
  curShown: number | null;
  newShown: number | null;
  /** 仅 out 行给：newShown - curShown；任一端无数据时不硬算 */
  delta: number | null;
}

/**
 * 逐槽 diff 行：按 slots 顺序一行一槽。推荐没填上的槽（候选不足 / 该槽对全员都不可分配）：
 * 有现任 = 照旧摆着（keep），空槽 = 整行不出（没有可预告的变化）。
 * curPidOf / recPidOf / shownOf 由调用方注入（names 草稿、optimalXI 结果、fitOfPid），这里不碰状态。
 */
export function fitDiffRows(
  slots: readonly FitDiffSlot[],
  curPidOf: (lid: number) => number | null,
  recPidOf: (lid: number) => number | null,
  shownOf: (pid: number, slotKey: string) => number | null,
): FitDiffRow[] {
  const rows: FitDiffRow[] = [];
  for (const s of slots) {
    const cur = curPidOf(s.lid);
    const rec = recPidOf(s.lid);
    if (rec == null) {
      if (cur == null) continue;
      const shown = shownOf(cur, s.slotKey);
      rows.push({
        lid: s.lid,
        position: s.position,
        kind: "keep",
        curPid: cur,
        newPid: cur,
        curShown: shown,
        newShown: shown,
        delta: null,
      });
      continue;
    }
    if (cur != null && cur === rec) {
      const shown = shownOf(cur, s.slotKey);
      rows.push({
        lid: s.lid,
        position: s.position,
        kind: "keep",
        curPid: cur,
        newPid: rec,
        curShown: shown,
        newShown: shown,
        delta: null,
      });
      continue;
    }
    if (cur == null) {
      rows.push({
        lid: s.lid,
        position: s.position,
        kind: "in",
        curPid: null,
        newPid: rec,
        curShown: null,
        newShown: shownOf(rec, s.slotKey),
        delta: null,
      });
      continue;
    }
    const curShown = shownOf(cur, s.slotKey);
    const newShown = shownOf(rec, s.slotKey);
    rows.push({
      lid: s.lid,
      position: s.position,
      kind: "out",
      curPid: cur,
      newPid: rec,
      curShown,
      newShown,
      delta: curShown != null && newShown != null ? newShown - curShown : null,
    });
  }
  return rows;
}

// —— 阵型对比（B2 计划 S3 / spec §5.4）——

export interface FitCompareDetail {
  lid: number;
  position: string;
  /** 该槽分到的人；null = 无可推荐（候选不足 / 全员在该槽无分） */
  pid: number | null;
  /** rankShown（显示口径）；无推荐时为 null */
  shown: number | null;
}

export interface FitCompareRow {
  form: string;
  /** 最优分配后的全队 Σ rankRaw 取整（显示与排序同口径）；无可推荐为 null（排尾） */
  total: number | null;
  /** 11 槽分配明细，短板在前：无推荐槽最先，其后 FIT 升序；无可推荐为 null */
  details: FitCompareDetail[] | null;
}

/**
 * 全部阵型各跑一次 optimalXI（29 × 毫秒级）。每槽的「位置|角色」由 pairOf 给——
 * 角色级权重、重心不影响分（spec §4.1），所以这里只消费 role；调用方对当前阵型注入
 * 教练已调的角色/重心、其余阵型注入默认角色（spec §5.4 口径）。候选池沿用一键推荐的
 * recPool，各阵型总分才可比。列表按取整总分降序，并列保持 FORMS 声明序（sort 稳定）。
 */
export function fitCompareRows(
  forms: readonly { value: string; pos: readonly { lid: number; position: string }[] }[],
  pairOf: (form: string, lid: number, position: string) => { role: string; focus: string },
  poolPids: readonly number[],
  fitOfPid: ReadonlyMap<number, FitProfile | null>,
): FitCompareRow[] {
  const rows: FitCompareRow[] = [];
  for (const f of forms) {
    const slots = f.pos.map((p) => ({
      lid: p.lid,
      position: p.position,
      slotKey: `${p.position}|${pairOf(f.value, p.lid, p.position).role}`,
    }));
    const res = optimalXI(
      slots.map((s) => ({
        key: String(s.lid),
        weightOf: (pid: number) => fitOfPid.get(pid)?.get(s.slotKey)?.rankRaw ?? null,
      })),
      [...poolPids], // optimalXI 收可变数组；内部本来就按 Set 去重，拷贝一份即可
    );
    if (res == null) {
      rows.push({ form: f.value, total: null, details: null });
      continue;
    }
    const details: FitCompareDetail[] = slots.map((s) => {
      const pid = res.assignment.get(String(s.lid)) ?? null;
      return {
        lid: s.lid,
        position: s.position,
        pid,
        shown: pid != null ? (fitOfPid.get(pid)?.get(s.slotKey)?.rankShown ?? null) : null,
      };
    });
    // 短板在前：无推荐（没分到人）是最大的短板排最先，其后按显示分升序，同分按槽序
    details.sort((a, b) => {
      if (a.pid == null || b.pid == null) {
        if (a.pid == null && b.pid == null) return a.lid - b.lid;
        return a.pid == null ? -1 : 1;
      }
      return (a.shown ?? 0) - (b.shown ?? 0) || a.lid - b.lid;
    });
    rows.push({ form: f.value, total: Math.round(res.total), details });
  }
  rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  return rows;
}

// —— 替补角色化（B2 计划 S4 / spec §5.5）——

export interface FitBenchTag {
  /** 槽位键（"ST|AF"，与 ROLE_FIT / fitProfileAll 同键） */
  slot: string;
  /** 该槽位绝对分显示口径 rankShown（「打上去是什么水平」） */
  shown: number;
}

/**
 * 替补槽的「擅长」行：个人内 fitTile 降序取 top3（他最适合打哪），值给该槽 rankShown
 * （打上去什么水平，与候选面板行首同口径）。只统计本位置群槽位——门将的场上槽位现在
 * fitTile 记 0 分（2026-10-29 口径），必须按槽位族跳过，否则「擅长 ST|AF 0」会混进榜；
 * 场上球员的 GK 族槽同样跳过。并列时按 shown 降序、再按槽位键稳定序。
 * profile 为 null（无 meta）或未选人由调用方传 null/undefined → 返回空数组，整行不渲染。
 */
export function fitBenchTopTags(
  profile: FitProfile | null | undefined,
  group: FitGroup,
  max = 3,
): FitBenchTag[] {
  if (!profile) return [];
  const tagged: { slot: string; tile: number; shown: number }[] = [];
  for (const [slot, s] of profile) {
    if (!s) continue;
    if (slot.startsWith("GK|") !== (group === "GK")) continue; // 跨位置群不计入「擅长」
    const tile = fitTile(profile, slot, group);
    if (tile == null) continue;
    tagged.push({ slot, tile, shown: s.rankShown });
  }
  return tagged
    .sort(
      (a, b) =>
        b.tile - a.tile ||
        b.shown - a.shown ||
        (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0),
    )
    .slice(0, max)
    .map(({ slot, shown }) => ({ slot, shown }));
}
