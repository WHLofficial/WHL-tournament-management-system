-- 0038：match_event 增加进球方式（method）/ 助攻方式（assist_method）两列。
-- 词表真源在 shared/methods.ts（worker 校验与前端下拉共用），与 docs/news-method-copybank.md §2/§3 一致。
-- ADD COLUMN 带 CHECK 对 SQLite 可行，只约束新写入的行，无需照 0002 重建表
--（0002 重建是因为改 type 的 CHECK 枚举本身，ADD COLUMN 改不了旧约束）；
-- 旧行两列为 NULL，零回填。pen_goal / own_goal 两列不记值、solo 与 free_kick（直接打门）不记助攻、
-- assist_method 仅在选了助攻人时允许——这些联动由录入端与 worker 校验实现，CHECK 只做单列白名单。

ALTER TABLE match_event ADD COLUMN method TEXT
  CHECK (method IN ('long_shot','curler','drive','header','volley','chip','tap_in','rebound','one_on_one','free_kick','counter','solo','first_time','turn_shot') OR method IS NULL);

ALTER TABLE match_event ADD COLUMN assist_method TEXT
  CHECK (assist_method IN ('cross_45','cross_byline','through_ball','long_pass','lofted_pass','cutback','give_and_go','dribble_pass','set_piece','corner_kick','free_kick_delivery','backheel','keeper_launch') OR assist_method IS NULL);
