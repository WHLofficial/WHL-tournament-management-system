-- v5.6.1：带入倍率的口径从「百分数」改成「倍数」（1 = 源分照搬、0.5 = 一半、0 = 不带分）。
--
-- 5.6.0 期间界面上写进 config_json.carry 的是百分数（100 表示 100%），代码现在按倍数解读，
-- 不换算的话老配置会立刻变成 ×100。这里一次性除以 100，换算后语义不变（100 → 1）。
-- 换算本身不改动任何榜：值只影响下一次重算，带上来的分和改口径前一模一样。
-- 只处理 config_json 里确实有 carry.multiplier 且是数字的阶段；其余原样不动。
UPDATE stage
SET config_json = json_set(
  config_json,
  '$.carry.multiplier',
  ROUND(CAST(json_extract(config_json, '$.carry.multiplier') AS REAL) / 100, 6)
)
WHERE json_valid(config_json)
  AND json_type(config_json, '$.carry.multiplier') IN ('integer', 'real');
