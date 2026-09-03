-- entry 级赛事扣分（超管操作），积分重算时净扣，允许净分为负
ALTER TABLE entry ADD COLUMN points_deducted INTEGER NOT NULL DEFAULT 0;
