// 伤病名库：静态编目，照 copybanks 句库纪律（确定性、无随机源，抽选走 shared/textpick）。
// 口径是足球场上的运动伤病（踝、腿筋、内收肌、头面部、膝、跖骨这些高频部位），
// 不写篮球／格斗式的伤名。分档只是编写参考——轻伤取两周内能痊愈的，重伤取两周以上；
// 系统不据此推算缺阵，缺阵场次一律由管理员手动勾选。
import { pickWeighted } from "./textpick";

export type InjurySeverity = "minor" | "major";

export interface InjuryCatalogItem {
  name: string;
  severity: InjurySeverity;
  // 常见度权重：4 常见、3 较常见、2 偶见、1 少见。两个档位内部都分常见与不常见。
  // 只用于「随机伤名」抽选和下拉排序，不是流行病学数据。
  weight: number;
}

// 轻伤档：预计两周内复出。踝扭伤、腿筋拉伤、内收肌拉伤是足球最高频的三类。
// 重伤档：预计两周以上。十字韧带、跟腱、跖骨骨折、脑震荡是足球的标志性重伤。
export const INJURY_CATALOG: InjuryCatalogItem[] = [
  { name: "踝关节扭伤", severity: "minor", weight: 4 },
  { name: "大腿后侧拉伤", severity: "minor", weight: 4 },
  { name: "内收肌拉伤", severity: "minor", weight: 4 },
  { name: "肌肉抽筋", severity: "minor", weight: 4 },
  { name: "大腿前侧拉伤", severity: "minor", weight: 3 },
  { name: "小腿拉伤", severity: "minor", weight: 3 },
  { name: "膝盖挫伤", severity: "minor", weight: 3 },
  { name: "脚踝挫伤", severity: "minor", weight: 3 },
  { name: "腹股沟拉伤", severity: "minor", weight: 2 },
  { name: "大腿挫伤", severity: "minor", weight: 2 },
  { name: "鼻出血", severity: "minor", weight: 2 },
  { name: "眉骨缝针", severity: "minor", weight: 2 },
  { name: "腰部痉挛", severity: "minor", weight: 2 },
  { name: "脚趾挫伤", severity: "minor", weight: 2 },
  { name: "髋部挫伤", severity: "minor", weight: 1 },
  { name: "手腕挫伤", severity: "minor", weight: 1 },
  { name: "颈部扭伤", severity: "minor", weight: 1 },
  { name: "牙齿折断", severity: "minor", weight: 1 },
  { name: "前交叉韧带撕裂", severity: "major", weight: 4 },
  { name: "大腿肌肉撕裂", severity: "major", weight: 4 },
  { name: "脑震荡", severity: "major", weight: 4 },
  { name: "跖骨骨折", severity: "major", weight: 4 },
  { name: "半月板损伤", severity: "major", weight: 3 },
  { name: "膝关节内侧副韧带撕裂", severity: "major", weight: 3 },
  { name: "小腿肌肉撕裂", severity: "major", weight: 3 },
  { name: "内收肌撕裂", severity: "major", weight: 3 },
  { name: "踝关节骨折", severity: "major", weight: 3 },
  { name: "跟腱断裂", severity: "major", weight: 2 },
  { name: "肋骨骨裂", severity: "major", weight: 2 },
  { name: "腓骨骨折", severity: "major", weight: 2 },
  { name: "锁骨骨折", severity: "major", weight: 2 },
  { name: "膝盖骨裂", severity: "major", weight: 2 },
  { name: "后交叉韧带撕裂", severity: "major", weight: 1 },
  { name: "膝关节外侧副韧带撕裂", severity: "major", weight: 1 },
  { name: "髌骨脱位", severity: "major", weight: 1 },
  { name: "眼眶骨折", severity: "major", weight: 1 },
  { name: "肩关节脱位", severity: "major", weight: 1 },
];

const byName = new Map(INJURY_CATALOG.map((it) => [it.name, it]));

export function findInjuryCatalog(name: string): InjuryCatalogItem | null {
  return byName.get(name) ?? null;
}

// 事件类型 ↔ 档位：injury_minor 只能配轻伤名，injury_major 只能配重伤名
export function severityOfEventType(type: "injury_minor" | "injury_major"): InjurySeverity {
  return type === "injury_minor" ? "minor" : "major";
}

// 档位内的伤病名，按常见度从高到低（下拉列表的顺序就是「常见的排前面」）
export function injuryNamesOf(severity: InjurySeverity): InjuryCatalogItem[] {
  return INJURY_CATALOG.filter((it) => it.severity === severity).sort(
    (a, b) => b.weight - a.weight,
  );
}

// 随机伤名：只在同档位内抽，常见伤权重高、少见伤权重低（同一 seed 结果固定）
export function pickInjuryName(severity: InjurySeverity, seed: string): string {
  return pickWeighted(seed, injuryNamesOf(severity), (it) => it.weight).name;
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
