// 二部图最大权匹配（B2 计划 S1 / spec §5.3-§5.4）：一键推荐与阵型对比共用的纯函数，
// 无 IO 无依赖。权重口径由调用方给（S2/S3 传 fitRankRaw，未截断，见 shared/fitScore.ts）。
// 语义：
// - weightOf 返回 null = 该球员在该槽位不可分配（无 meta / 6 键全缺），不建边；
// - 候选人数少于槽位、或某槽位对所有候选都不可分配 → 该槽空着（无推荐），一人至多占一槽；
// - 空候选、或所有「槽位×候选」对都不可分配（一条边都没有）→ 返回 null（无可推荐，
//   区别于总分 0）；「候选不足返回 null」按计划测试组③口径只指这两种，候选比槽位少但
//   能分出去的照常返回带空槽的结果。
//
// 实现：手写 Kuhn–Munkres（JV 势能 + 最短增广路，O(n³)）。矩形阵补 0 权虚点化方阵
// （n = max(槽位, 候选) ≤ 40，毫秒级）；「最大化 w」经 cost = C - w（C = 最大真实权重）
// 变换为「最小化 cost」，虚点/缺边代价 = C（等价权 0）——全部代价非负，浮点下对偶势能
// 的 delta ≥ 0 不被破坏，不依赖实现碰巧容忍负权。总权重回填时直接从原权重矩阵求和，
// 不经 cost 往返，避免浮点漂移。

/**
 * 二部图最大权匹配：slots（≤11）× candidates（≤ 全队）。
 * 权重用 fitRankRaw（未截断），返回 Map<slotKey, playerPid> 与总权重。
 * 槽位多于可分配候选时允许空槽（该槽无推荐）；候选不足返回 null。
 * candidatePids 应互异（同一 pid 重复传入会按多人计，违背「一人只占一槽」），实现里去重兜底。
 */
export function optimalXI(
  slots: { key: string; weightOf: (pid: number) => number | null }[],
  candidatePids: number[],
): { assignment: Map<string, number>; total: number } | null {
  const pids = [...new Set(candidatePids)];
  const s = slots.length;
  const p = pids.length;
  if (s === 0 || p === 0) return null;

  // 权重矩阵 W[槽位][候选]，null = 不可分配；C = 最大真实权重（变换基准）
  const W: (number | null)[][] = slots.map((sl) =>
    pids.map((pid) => sl.weightOf(pid)),
  );
  let cMax = -Infinity;
  for (const row of W) for (const w of row) if (w !== null && w > cMax) cMax = w;
  if (cMax === -Infinity) return null; // 一条边都没有：槽位全不可分配

  const n = Math.max(s, p);
  // 代价矩阵 1 基（e-maxx 版习惯）：a[i][j]，行 i = 槽位（含虚槽），列 j = 候选（含虚人）
  const a: number[][] = [new Array<number>(n + 1).fill(0)]; // a[0] 占位
  for (let i = 1; i <= n; i++) {
    const row: number[] = [0];
    for (let j = 1; j <= n; j++) {
      const w = i <= s && j <= p ? W[i - 1][j - 1] : null;
      row.push(w === null ? cMax : cMax - w);
    }
    a.push(row);
  }

  const u = new Array<number>(n + 1).fill(0); // 行势能
  const v = new Array<number>(n + 1).fill(0); // 列势能
  const match = new Array<number>(n + 1).fill(0); // match[j] = 与列 j 匹配的行（0 = 未配）
  const way = new Array<number>(n + 1).fill(0); // 增广路回溯
  for (let i = 1; i <= n; i++) {
    match[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = match[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[match[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (match[j0] !== 0);
    do {
      const j1 = way[j0];
      match[j0] = match[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // 行 → 列反查回填：只收真实（槽位, 候选）对。缺边（W null）被选中只可能发生在
  // 全 0 权并列的退化局，代价与虚边相同且权重贡献为 0，跳过不影响最优性。
  const colOfRow = new Array<number>(n + 1).fill(0);
  for (let j = 1; j <= n; j++) if (match[j] !== 0) colOfRow[match[j]] = j;
  const assignment = new Map<string, number>();
  let total = 0;
  for (let i = 1; i <= s; i++) {
    const j = colOfRow[i];
    if (j === 0 || j > p) continue; // 虚列 = 该槽空着
    const w = W[i - 1][j - 1];
    if (w === null) continue;
    assignment.set(slots[i - 1].key, pids[j - 1]);
    total += w;
  }
  if (assignment.size === 0) return null; // 只剩 0/负权并列的退化局：无可推荐
  return { assignment, total };
}
