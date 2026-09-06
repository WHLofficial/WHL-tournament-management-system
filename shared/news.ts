// #13 头版门户 DTO。独立成文件：并行会话正在修改 shared/types.ts，这里只新增文件零接触。
import type { MatchEventType } from "./types";

export type FeedKind =
  | "match" // 战报（头条素材）
  | "walkover" // 弃权判负
  | "recap" // 轮次综述
  | "leader" // 榜首易主
  | "streak" // 纪录（连胜/零封/不败）
  | "milestone" // 里程碑（进球档位/射手榜易主）
  | "rescore" // 更正启事
  | "discipline" // 红牌即时快讯
  | "weekly"; // 周报

// 快讯条目：纯派生物（读时现算），确定性 id 保证同数据同输出。
// 点击去向由 kind + 可选字段在前端推导，不存冗余 URL。
export interface FeedItemDTO {
  // match:{mid} / wo:{mid} / recap:{sid}:{r} / leader:{mid} / streak:{mid}:{entryId}
  // / milestone:{mid}:{playerId} / rescore:{auditId} / discipline:{eventId} / weekly:{weekStart}
  id: string;
  kind: FeedKind;
  at: string | null; // 条目事实时间（ISO UTC），橱窗/档案页排序键
  title: string;
  body: string;
  tournamentId?: number;
  tournamentName?: string;
  matchId?: number; // match/walkover/rescore/discipline 携带
  stageId?: number; // recap 携带
  round?: number; // recap 携带
  weekStart?: string; // weekly 携带（YYYY-MM-DD，周一）
  // 头条对撞卡需要的字段（仅 match/walkover 条目）
  homeTeamName?: string;
  awayTeamName?: string;
  homeLogoUrl?: string | null;
  awayLogoUrl?: string | null;
  scoreHome?: number;
  scoreAway?: number;
  roundLabel?: string;
}

export interface AnnouncementDTO {
  id: number;
  title: string;
  body: string;
  updatedAt: string;
}

export interface WeeklyMatchDTO {
  matchId: number;
  tournamentId: number;
  tournamentName: string;
  homeTeamName: string;
  awayTeamName: string;
  scoreHome: number;
  scoreAway: number;
  finishedAt: string | null;
}

export interface WeeklyDTO {
  weekStart: string; // YYYY-MM-DD（周一，UTC 口径）
  label: string; // 「09.01 – 09.07」
  isFallback: boolean; // 本周无比赛、回退最近有比赛的一周时 true
  played: number;
  goals: number;
  biggestMargin: { matchId: number; tournamentId: number; score: string } | null;
  cleanSheets: number; // 零封场数（弃权场不计）
  ownGoals: number;
  topScorer: { name: string; teamName: string; goals: number } | null;
  bestDefense: { teamName: string; conceded: number } | null;
  matches: WeeklyMatchDTO[];
}

// 单场战报文章：倒金字塔五段由后端预渲染，数据不动文章一字不动
export interface ReportGoalDTO {
  minute: number | null;
  playerName: string | null;
  teamName: string;
  side: "home" | "away";
  type: MatchEventType; // goal / pen_goal / own_goal
}

export interface ReportCardDTO {
  type: "yellow" | "red"; // red_2y 归入 red
  minute: number | null;
  playerName: string | null;
  teamName: string;
}

// 轮次综述（某轮全部完赛后自动生成的赛事级叙事页）
export interface RecapDTO {
  tournamentId: number;
  tournamentName: string;
  stageId: number;
  round: number;
  roundLabel: string;
  isComplete: boolean; // 该轮是否已全部完赛（未完赛也可访问，标注后仍显示当前统计）
  played: number;
  goals: number;
  cleanSheets: number;
  biggestMargin: { matchId: number; label: string; score: string } | null;
  topScorer: { name: string; teamName: string; goals: number } | null;
  standings: { rank: number; teamName: string; played: number; pts: number }[]; // 单表联赛阶段前 5；淘汰赛/多组小组赛为空
  paragraphs: string[]; // 概述句
  matches: WeeklyMatchDTO[];
}

export interface MatchReportDTO {
  matchId: number;
  tournamentId: number;
  tournamentName: string;
  roundLabel: string;
  finishedAt: string | null;
  homeTeamName: string;
  awayTeamName: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  scoreHome: number;
  scoreAway: number;
  penHome: number | null;
  penAway: number | null;
  walkoverSide: "" | "home" | "away" | "both";
  title: string;
  lede: string;
  paragraphs: string[]; // 过程段
  context: string[]; // 赛事背景段（数据齐才写；空数组 = 整段省略）
  goals: ReportGoalDTO[];
  cards: ReportCardDTO[];
  note: string | null; // 弃权备注原文
}
