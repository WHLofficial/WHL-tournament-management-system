-- #26 球员元数据（FC26 属性 / 徽章 / 身高）：随名册同步从俱乐部平台拉取并镜像入库。
--
-- 为什么要有这张表：战术页编辑队长与定位球（shared/tactics.ts 的 18 个 AssignKey）时，每个候选球员
-- 要显示相关属性的 pill 与金银徽章 chip。真源在俱乐部平台（players.game_attrs 71 键 JSON +
-- player_playstyles 明细表），本仓不复制那套业务规则，只在同步时把「按 fc_id 取数」的结果镜像下来 ——
-- 否则每开一次战术板就要跨仓打 club 一次，而且 club 侧的下发口径（金徽 = 基础 id + 100）会散进 UI。
--
-- 口径：
-- - fc_id 就是 player.id（两库同一次 rekey，见 worker/lib/clubRoster.ts 的对账语义），一人一行；
-- - height 单列（club 端点单独下发，取不到写 NULL）；attrs / playstyles 存 club 下发的原样 JSON 文本，
--   解析与脏值过滤在读侧（worker/lib/playerMeta.ts）做 —— 存的时候不猜，坏数据也就坏一行；
-- - 每次同步整行覆盖并更新 synced_at，本表没有别的写者，不存在两侧互相覆盖的问题；
-- - 不挂 player 外键：名册对账会因外键拦阻而保留「有比赛事件引用」的旧球员，镜像副本多留一行
--   无副作用（读侧只按战术页点到的 id 查），而挂上外键会让外键失败拖垮整批 upsert。
CREATE TABLE IF NOT EXISTS player_meta (
  fc_id      INTEGER PRIMARY KEY,
  height     INTEGER,
  attrs      TEXT NOT NULL DEFAULT '{}',
  playstyles TEXT NOT NULL DEFAULT '[]',
  synced_at  TEXT NOT NULL
);
