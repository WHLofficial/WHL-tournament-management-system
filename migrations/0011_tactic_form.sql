-- #13 战术板远期「在线提交战术阵容」启用：公开需展示阵型，submission 补一列
ALTER TABLE tactic_submission ADD COLUMN form TEXT NOT NULL DEFAULT '';
