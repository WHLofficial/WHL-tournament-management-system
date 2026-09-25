# FC26 ID 对齐重键 SQL 生成器（v2.0.0 数据底座，2026-09-16）
# 输入：players-dump.json（tour player 生产快照）、player-match.json（名字匹配产物）、teams-map.json（tour team → EA FC 队 ID）
# 输出：rekey-fc26.sql（两阶段重键，PRAGMA defer_foreign_keys 靠 D1 单批事务）+ multi-report.md（歧义清单，管理组复核）
# 口径：matched 球员 player.id 换 EA 球员 ID（fc_id 同键）；multi 球员暂留本地 id 待管理组裁决后补迁。
#       子表引用全部级联改写：team 引用 7 表 + match_event(player/assist)/motm_vote + tactic_submission.slots_json（JSON 重写）。
#       temp 空间：team 子引用与 team.id 用 old+10000000（与 EA 队 id ≤112172 不相交）；
#                 player 用 old+20000000（EA 球员 id ≤280142 < 20000001，不相交）。
import json, os

BASE = os.path.dirname(os.path.abspath(__file__))

def load(name):
    return json.load(open(os.path.join(BASE, name), encoding='utf-8'))

tour = (lambda d: (d if isinstance(d, list) else [d])[0]['results'])(load('players-dump.json'))
pm = load('player-match.json')
team_map = {int(k): v for k, v in load('teams-map.json').items()}

team_children = ['player', 'team_member', 'auth_code', 'entry', 'tactic', 'tactic_submission']  # standing 走 entry_id，不引用 team
old_team_ids = sorted(team_map)
team_cases = ' '.join(f'WHEN {o + 10000000} THEN {team_map[o]}' for o in old_team_ids)

# matched: 516 名；multi 球员保留本地 id
pmap = [(r['id'], r['ea_id']) for r in pm['matched']]
old_player_ids = [o for o, _ in pmap]
pl_cases = ' '.join(f'WHEN {o + 20000000} THEN {e}' for o, e in pmap)

# slots_json 重写：解析 JSON，把 player_id 按 pmap 换成 EA id（未匹配不动）
new_slots = {}
for row in load('tactic-slots-dump.json') if os.path.exists(os.path.join(BASE, 'tactic-slots-dump.json')) else []:
    new_slots[row['id']] = row['new_slots_json']

sql = ['-- FC26 ID 对齐重键（生成：scripts/fc26-id-rekey/generate.py；勿手改）',
       'PRAGMA defer_foreign_keys = ON;', '']
in_list = ','.join(str(o) for o in old_team_ids)
sql += [f'UPDATE {t} SET team_id = team_id + 10000000 WHERE team_id IN ({in_list});' for t in team_children]
sql += ['UPDATE team SET id = id + 10000000 WHERE id IN (%s);' % in_list, '']
sql += [f'UPDATE team SET id = {team_map[o]} WHERE id = {o + 10000000};' for o in old_team_ids]
sql += [f'UPDATE {t} SET team_id = CASE team_id {team_cases} ELSE team_id END WHERE team_id > 10000000;' for t in team_children]
sql += ['']
pin = ','.join(str(o) for o in old_player_ids)
sql += [f'UPDATE match_event SET player_id = player_id + 20000000 WHERE player_id IN ({pin});',
        f'UPDATE match_event SET assist_player_id = assist_player_id + 20000000 WHERE assist_player_id IN ({pin});',
        f'UPDATE motm_vote SET player_id = player_id + 20000000 WHERE player_id IN ({pin});', '']
sql += ['UPDATE player SET id = id + 20000000 WHERE id IN (%s);' % pin, '']
sql += [f'UPDATE player SET id = {e} WHERE id = {o + 20000000};' for o, e in pmap]
sql += ['',
        f'UPDATE match_event SET player_id = CASE player_id {pl_cases} ELSE player_id END,'
        f' assist_player_id = CASE assist_player_id {pl_cases} ELSE assist_player_id END'
        ' WHERE player_id > 20000000 OR assist_player_id > 20000000;',
        f'UPDATE motm_vote SET player_id = CASE player_id {pl_cases} ELSE player_id END WHERE player_id > 20000000;']
# slots_json 重写行（tactic-slots-dump.json 预生成：id + new_slots_json）
slots_rows = load('tactic-slots-dump.json') if os.path.exists(os.path.join(BASE, 'tactic-slots-dump.json')) else []
sql += [f"UPDATE tactic_submission SET slots_json = '{s['new_slots_json'].replace(chr(39), chr(39)*2)}' WHERE id = {s['id']};"
        for s in slots_rows]
# roster_json 重写行（tactic-roster-dump.json 预生成：值是字符串型 player_id，按值映射）
roster_rows = load('tactic-roster-dump.json') if os.path.exists(os.path.join(BASE, 'tactic-roster-dump.json')) else []
sql += [f"UPDATE tactic SET roster_json = '{s['new_roster_json'].replace(chr(39), chr(39)*2)}' WHERE id = {s['id']};"
        for s in roster_rows]
open(os.path.join(BASE, 'rekey-fc26.sql'), 'w', encoding='utf-8', newline='\n').write('\n'.join(sql) + '\n')

# 歧义报告
lines = ['# FC26 球员 ID 对齐——歧义清单（管理组复核）', '',
         f'- 自动匹配 {len(pm["matched"])} 人（player.id → EA id）；歧义 {len(pm["multi"])} 人暂留本地 id', '',
         '| tour 队 | 球员（号码） | 候选 FC 球员（id / 名 / FC26 所属队） |', '| --- | --- | --- |']
tour_names = {1:'巴黎圣日耳曼',2:'里昂',3:'利物浦',4:'曼联',5:'慕尼黑1860',6:'巴塞罗那(CPU)',7:'纽卡斯尔联',8:'尤文图斯',9:'佛罗伦萨',10:'切尔西',12:'皇家贝蒂斯',13:'阿斯顿维拉',14:'拜仁慕尼黑',15:'阿森纳',16:'曼城(CPU)',17:'奥林匹亚科斯',18:'诺丁汉森林',19:'RB莱比锡(CPU)',20:'皇家马德里',21:'AC米兰(CPU)'}
for r in sorted(pm['multi'], key=lambda x: (x['team_id'], x['name'])):
    cands = '；'.join(f"{c[0]} {c[1]} (FC 队 {c[2]})" for c in r['candidates'])
    lines.append(f"| {tour_names.get(r['team_id'], r['team_id'])} | {r['name']}（{r['number']}，旧 id {r['id']}） | {cands} |")
open(os.path.join(BASE, 'multi-report.md'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('SQL statements:', sum(1 for _ in open(os.path.join(BASE, 'rekey-fc26.sql'), encoding='utf-8')))
print('multi:', len(pm['multi']), 'matched:', len(pmap))
