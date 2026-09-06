-- 弃权判负（排期 #10）：match.walkover_side 标记弃权方
-- '' = 普通场；'home' / 'away' = 单方弃权（比分记 0:3，弃权方 0）；
-- 'both' = 双弃权（比分 0:0，双方各记负 0 分）。备注写 match.note（建表注释即「弃权判负等备注」）。
ALTER TABLE match ADD COLUMN walkover_side TEXT NOT NULL DEFAULT '';
