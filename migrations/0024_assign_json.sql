-- #24 球员指派（FC26 Assignments）：submit 与存档各存一份「角色码 → 球员 id」映射
-- 形如 {"captain": 123, "ca_left": 45}，只存已填项；键是角色码不是位置，换阵型/换人不影响已填内容。
-- 两处都加：tactic_submission 用于随阵容提交落库并展示，tactic 用于跨场复用回填。
ALTER TABLE tactic_submission ADD COLUMN assign_json TEXT NOT NULL DEFAULT '';
ALTER TABLE tactic ADD COLUMN assign_json TEXT NOT NULL DEFAULT '';
