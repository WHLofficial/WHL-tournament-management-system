-- 补 0021 漏掉的数据约束：一个伤病事件只能挂一条登记。
-- 应用层已有「已建过登记」的预检，但那挡不住并发双提交（两次 POST 同时通过预检）；
-- 唯一索引把不变量落到库里，撞上由路由转成 409 提示。
CREATE UNIQUE INDEX idx_injury_event_uniq ON injury(event_id);
