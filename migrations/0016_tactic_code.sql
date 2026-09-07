-- 战术码备案：教练提交阵容时把战术板编码串（FUT26 格式）一起存档。
-- 管理端单场备案可见；公开端 lineup 接口不返回该列。
ALTER TABLE tactic_submission ADD COLUMN code TEXT NOT NULL DEFAULT '';
