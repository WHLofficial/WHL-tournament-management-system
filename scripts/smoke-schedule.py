# -*- coding: utf-8 -*-
"""编排 API 烟测：建赛(3 赛制 stage 结构)/generate/draw/手动落场/删除/patch同步"""
import json
import urllib.request

BASE = "http://127.0.0.1:8780"
JAR = {}
ok = fail = 0

def req(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if JAR.get("cookie"):
        r.add_header("Cookie", JAR["cookie"])
    try:
        with urllib.request.urlopen(r) as resp:
            sc = resp.headers.get("set-cookie")
            if sc and "session" in sc:
                JAR["cookie"] = sc.split(";")[0]
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:120]}

def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} :: {detail}")

s, b = req("POST", "/api/auth/login", {"name": "admin", "password": "admin12345"})
check("登录", s == 200)

# 清理历史烟测脏数据
s, b = req("GET", "/api/admin/tournaments")
for t in b.get("tournaments", []):
    if t["name"].startswith("编排烟测"):
        req("DELETE", f"/api/admin/tournaments/{t['id']}")
        print(f"  (清理遗留赛事 {t['id']})")

def detail(tid):
    s, b = req("GET", f"/api/admin/tournaments/{tid}")
    assert s == 200, b
    return b

# ---------- 1. 建赛 stage 结构 ----------
s, b = req("POST", "/api/admin/tournaments", {"name": "编排烟测单淘", "format": "single_elim"})
tid_e = b.get("id"); check("建单淘赛", s == 201 and tid_e, str(b))
d = detail(tid_e)
check("单淘 stage=1 elim", len(d["stages"]) == 1 and d["stages"][0]["kind"] == "elim", str(d["stages"]))

s, b = req("POST", "/api/admin/tournaments", {"name": "编排烟测循环", "format": "round_robin"})
tid_r = b.get("id"); check("建循环赛", s == 201 and tid_r, str(b))
d = detail(tid_r)
check("循环 stage=1 round_robin", len(d["stages"]) == 1 and d["stages"][0]["kind"] == "round_robin", str(d["stages"]))

s, b = req("POST", "/api/admin/tournaments", {"name": "编排烟测小组", "format": "group_knockout"})
tid_g = b.get("id"); check("建小组赛", s == 201 and tid_g, str(b))
d = detail(tid_g)
gs = next(x for x in d["stages"] if x["kind"] == "group")
es = next(x for x in d["stages"] if x["kind"] == "elim")
check("小组+淘汰双 stage", len(d["stages"]) == 2)
check("group config 带 cross", gs["config"].get("cross") == ["A1-B2", "B1-A2", "C1-D2", "D1-C2"], str(gs["config"]))
check("elim source.cross 继承", es["config"].get("source", {}).get("cross") == gs["config"].get("cross"), str(es["config"]))
check("小组行 A-D", sorted(g["name"] for g in d["groups"]) == ["A", "B", "C", "D"], str(d["groups"]))

# ---------- 2. 单淘：3 队 bye 结构 → 补到 4 队测 legs=2+季军赛 ----------
stage_e = d["stages"][0]["id"] if False else detail(tid_e)["stages"][0]["id"]
s, b = req("POST", f"/api/admin/tournaments/{tid_e}/entries/bulk", {"names": ["Alpha", "Beta", "Gamma"]})
check("单淘报名 3 队", s == 201 and b.get("createdEntries") == 3, f"{s} {b}")
s, b = req("POST", f"/api/admin/tournaments/{tid_e}/stages/{stage_e}/generate")
check("3队单淘 generate 3场(1bye+1real+决赛壳)", s == 200 and b.get("created") == 3 and b.get("rounds") == 2, f"{s} {b}")
s, b = req("GET", f"/api/admin/tournaments/{tid_e}/matches")
ms = b.get("matches", [])
r1 = [m for m in ms if m["round"] == 1]
bye = [m for m in r1 if m["note"] == "轮空"]
check("轮空场 pending+winner 预填", len(bye) == 1 and bye[0]["status"] == "pending" and bye[0]["winnerEntryId"] == bye[0]["homeEntryId"], str(bye)[:100])
check("Alpha 轮空 Beta vs Gamma", bye and bye[0]["homeTeamName"] == "Alpha" and any({m["homeTeamName"], m["awayTeamName"]} == {"Beta", "Gamma"} for m in r1), str([(m["homeTeamName"], m["awayTeamName"]) for m in r1]))

s, b = req("POST", f"/api/admin/tournaments/{tid_e}/entries/bulk", {"names": ["Delta"]})
check("补报名 Delta", s == 201 and b.get("createdEntries") == 1, f"{s} {b}")
s, b = req("PATCH", f"/api/admin/tournaments/{tid_e}", {"config_json": {"legs": 2, "third_place": True}})
check("PATCH legs=2+季军赛", s == 200, f"{s} {b}")
d = detail(tid_e)
check("PATCH 后 stage config 同步", d["stages"][0]["config"].get("legs") == 2 and d["stages"][0]["config"].get("third_place") is True, str(d["stages"][0]["config"]))
s, b = req("POST", f"/api/admin/tournaments/{tid_e}/stages/{stage_e}/generate")
check("4队 legs=2 生成 8 场", s == 200 and b.get("created") == 8, f"{s} {b}")
s, b = req("GET", f"/api/admin/tournaments/{tid_e}/matches")
ms = b.get("matches", [])
semi = [m for m in ms if m["round"] == 1]
l1 = next(m for m in semi if m["leg"] == 1 and m["homeTeamName"] == "Alpha")
l2 = next(m for m in semi if m["leg"] == 2 and m["homeTeamName"] == "Delta")
check("legs 主客互换(Alpha-Delta)", l1["homeEntryId"] == l2["awayEntryId"] and l1["awayEntryId"] == l2["homeEntryId"], str((l1, l2)))
third = [m for m in ms if m["round"] == 2 and m["slot"] == 2]
check("季军赛 2 场(与决赛同步)", len(third) == 2 and all(m["note"] == "季军赛" for m in third), str(third)[:100])
s, b = req("PATCH", f"/api/admin/tournaments/{tid_e}", {"config_json": {"legs": 1, "final_legs": 2}})
check("PATCH legs=1 final_legs=2", s == 200, f"{s} {b}")
s, b = req("POST", f"/api/admin/tournaments/{tid_e}/stages/{stage_e}/generate")
check("半决赛单场+决赛两回合=6 场", s == 200 and b.get("created") == 6, f"{s} {b}")
s, b = req("GET", f"/api/admin/tournaments/{tid_e}/matches")
ms = b.get("matches", [])
semi_legs = [m["leg"] for m in ms if m["round"] == 1 and m["homeTeamName"] == "Alpha"]
fin_legs = [m["leg"] for m in ms if m["round"] == 2 and m["slot"] == 1 and m["note"] is None]
check("半决赛无 leg、决赛 leg1/2", semi_legs == [None] and sorted(x for x in fin_legs if x) == [1, 2], str((semi_legs, fin_legs)))

# ---------- 3. 循环 generate（4 队单循环 = 6 场 3 轮） ----------
s, b = req("POST", f"/api/admin/tournaments/{tid_r}/entries/bulk", {"names": ["Red", "Blue", "Green", "White"]})
check("循环报名 4 队", s == 201 and b.get("createdEntries") == 4, f"{s} {b}")
stage_r = detail(tid_r)["stages"][0]["id"]
s, b = req("POST", f"/api/admin/tournaments/{tid_r}/stages/{stage_r}/generate")
check("循环 generate 12场6轮 balanced(默认双循环)", s == 200 and b.get("created") == 12 and b.get("rounds") == 6 and b.get("balanced") is True, f"{s} {b}")
s, b = req("GET", f"/api/admin/tournaments/{tid_r}/matches")
ms = b.get("matches", [])
pairs = {tuple(sorted([m["homeEntryId"], m["awayEntryId"]])) for m in ms}
check("每对恰交手 1 种(6 对×双循环)", len(pairs) == 6, str(len(pairs)))

target = ms[0]
s, _ = req("DELETE", f"/api/admin/tournaments/{tid_r}/matches/{target['id']}")
check("删 pending 场", s == 200, str(s))
s, b = req("POST", f"/api/admin/tournaments/{tid_r}/stages/{stage_r}/matches",
           {"round": target["round"], "homeEntryId": target["awayEntryId"], "awayEntryId": target["homeEntryId"]})
check("手动落场(主客互换)", s == 201, f"{s} {b}")
s, b = req("POST", f"/api/admin/tournaments/{tid_r}/stages/{stage_r}/matches",
           {"round": 3, "homeEntryId": target["homeEntryId"], "awayEntryId": target["awayEntryId"]})
check("重复交手拒绝", s == 409, f"{s} {b}")
conflict = next(m for m in ms if m["id"] != target["id"] and target["homeEntryId"] in (m["homeEntryId"], m["awayEntryId"]))
s, b = req("POST", f"/api/admin/tournaments/{tid_r}/stages/{stage_r}/matches",
           {"round": conflict["round"], "homeEntryId": target["homeEntryId"], "awayEntryId": next(e for e in [m["awayEntryId"] if m["homeEntryId"] == target["homeEntryId"] else m["homeEntryId"] for m in ms if m["id"] == conflict["id"]])})
check("同轮同队冲突拒绝", s == 409, f"{s} {b}")

# ---------- 4. 小组抽签 + generate（8 队 4 组） ----------
s, b = req("POST", f"/api/admin/tournaments/{tid_g}/entries/bulk", {"names": ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]})
check("小组赛报名 8 队", s == 201 and b.get("createdEntries") == 8, f"{s} {b}")
stage_g = next(x["id"] for x in detail(tid_g)["stages"] if x["kind"] == "group")
s, b = req("POST", f"/api/admin/tournaments/{tid_g}/stages/{stage_g}/generate")
check("未抽签生成拒绝", s == 400, f"{s} {b}")
s, b = req("POST", f"/api/admin/tournaments/{tid_g}/stages/{stage_g}/draw")
check("抽签 8 队 4 组每组 2 队", s == 200 and b.get("assigned") == 8 and all(len(v) == 2 for v in b.get("groups", {}).values()), f"{s} {b}")
s, b = req("POST", f"/api/admin/tournaments/{tid_g}/stages/{stage_g}/generate")
check("小组赛程 4场1轮(每组2队单循环)", s == 200 and b.get("created") == 4 and b.get("rounds") == 1 and b.get("skippedGroups") == [], f"{s} {b}")
s, b = req("GET", f"/api/admin/tournaments/{tid_g}/matches")
ms = b.get("matches", [])
d = detail(tid_g)
gid_name = {g["id"]: g["name"] for g in d["groups"]}
entry_group = {e["id"]: gid_name.get(e.get("groupId")) for e in d["entries"]}
cross = [m for m in ms if entry_group.get(m["homeEntryId"]) != entry_group.get(m["awayEntryId"])]
check("无跨组场次", len(cross) == 0, str(len(cross)))
# 重抽：抽签后组变化，旧赛程被 generate 清掉——重抽后再 generate 成功
s, b = req("POST", f"/api/admin/tournaments/{tid_g}/stages/{stage_g}/draw")
check("重抽成功(无开打球)", s == 200, f"{s} {b}")
s, b = req("POST", f"/api/admin/tournaments/{tid_g}/stages/{stage_g}/generate")
check("重抽后再生成", s == 200 and b.get("created") == 4, f"{s} {b}")

# ---------- 5. 清理 ----------
for t in (tid_e, tid_r, tid_g):
    s, _ = req("DELETE", f"/api/admin/tournaments/{t}")
    check(f"清理赛事 {t}", s == 200, str(s))

print(f"\n== 烟测结果: {ok} PASS / {fail} FAIL ==")
raise SystemExit(1 if fail else 0)
