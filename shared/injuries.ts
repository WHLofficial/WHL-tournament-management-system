// 伤病名库：静态编目，照 copybanks 句库纪律（确定性、无随机）。
// 编写参考——轻伤名取两周内能痊愈的伤，重伤名取两周以上才好的伤；
// suggestMiss 只是登记弹窗的预勾选建议（按场次，比赛无开赛时间字段），管理员可自由增删。
export type InjurySeverity = "minor" | "major";

export interface InjuryCatalogItem {
  name: string;
  severity: InjurySeverity;
  suggestMiss: number; // 预勾选缺阵场数；0 = 只记录不预勾
}

// 轻伤档：预计两周内复出（suggestMiss 0~1）
// 重伤档：预计两周以上（suggestMiss 2~4）
export const INJURY_CATALOG: InjuryCatalogItem[] = [
  { name: "擦伤", severity: "minor", suggestMiss: 0 },
  { name: "鼻血", severity: "minor", suggestMiss: 0 },
  { name: "抽筋", severity: "minor", suggestMiss: 0 },
  { name: "手指挫伤", severity: "minor", suggestMiss: 1 },
  { name: "眼眶淤青", severity: "minor", suggestMiss: 1 },
  { name: "头皮裂伤", severity: "minor", suggestMiss: 1 },
  { name: "膝盖擦破", severity: "minor", suggestMiss: 0 },
  { name: "轻微扭伤", severity: "minor", suggestMiss: 1 },
  { name: "轻微拉伤", severity: "minor", suggestMiss: 1 },
  { name: "腰背僵硬", severity: "minor", suggestMiss: 1 },
  { name: "脑震荡", severity: "major", suggestMiss: 3 },
  { name: "韧带撕裂", severity: "major", suggestMiss: 4 },
  { name: "骨折", severity: "major", suggestMiss: 4 },
  { name: "脱臼", severity: "major", suggestMiss: 2 },
  { name: "半月板损伤", severity: "major", suggestMiss: 4 },
  { name: "重度肌肉拉伤", severity: "major", suggestMiss: 3 },
  { name: "跟腱损伤", severity: "major", suggestMiss: 4 },
  { name: "肋骨骨裂", severity: "major", suggestMiss: 3 },
  { name: "脚踝重扭", severity: "major", suggestMiss: 2 },
  { name: "肩袖损伤", severity: "major", suggestMiss: 3 },
];

const byName = new Map(INJURY_CATALOG.map((it) => [it.name, it]));

export function findInjuryCatalog(name: string): InjuryCatalogItem | null {
  return byName.get(name) ?? null;
}

// 事件类型 ↔ 档位：injury_minor 只能配轻伤名，injury_major 只能配重伤名
export function severityOfEventType(type: "injury_minor" | "injury_major"): InjurySeverity {
  return type === "injury_minor" ? "minor" : "major";
}

// 预勾选建议：按伤病名库的 suggestMiss 预选接下来 N 场（仅辅助，管理端可改）
export function suggestMissIds(
  upcomingPendingMatchIds: number[],
  catalogName: string | null,
): number[] {
  if (!catalogName) return [];
  const item = findInjuryCatalog(catalogName);
  if (!item) return [];
  return upcomingPendingMatchIds.slice(0, item.suggestMiss);
}

// 对外文案用自然阶段，不写裸百分比（「伤愈 75%」读起来很怪）；
// 管理端表格里仍可直接显示百分比。
export function recoverStageLabel(percent: number): string {
  if (percent >= 100) return "已伤愈";
  if (percent >= 75) return "接近复出";
  if (percent >= 40) return "恢复中";
  if (percent > 0) return "刚受伤不久";
  return "刚开始缺阵";
}
