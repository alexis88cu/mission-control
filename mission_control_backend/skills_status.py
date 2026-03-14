#!/usr/bin/env python3
"""
Mission Control Backend Connector — Skills Status
Reads from:
  ~/ai_system/logs/skill_usage_log.jsonl
  ~/ai_system/logs/skill_changes_log.jsonl
"""

import json
import sys
import os
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict

AI_SYSTEM_BASE = Path(os.path.expanduser("~/ai_system"))

USAGE_LOG_PATHS = [
    AI_SYSTEM_BASE / "logs/skill_usage_log.jsonl",
    Path("/root/ai_system/logs/skill_usage_log.jsonl"),
    Path("/home/claude/ai_system/logs/skill_usage_log.jsonl"),
]
CHANGES_LOG_PATHS = [
    AI_SYSTEM_BASE / "logs/skill_changes_log.jsonl",
    Path("/root/ai_system/logs/skill_changes_log.jsonl"),
    Path("/home/claude/ai_system/logs/skill_changes_log.jsonl"),
]

FAMILY_LABELS = {
    "engineering":"Engineering","trading":"Trading & Finance","security":"Security",
    "data":"Data & Analysis","automation":"Automation","communication":"Communication",
    "coordination":"Coordination","research":"Research",
}
PROJECT_NAMES = {
    "proj-tl":"Trader League — La Logia","proj-fse":"Fire Sprinkler Estimator",
    "proj-infire":"Infire Portfolio / Blog","proj-sg":"Security Guardian",
    "proj-mc":"Mission Control","system":"System",
}

def _find_path(candidates):
    for p in candidates:
        if p.exists(): return p
    return None

def read_jsonl(path):
    entries = []
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line: continue
            try: entries.append(json.loads(line))
            except json.JSONDecodeError as e: sys.stderr.write(f"[WARN] {path.name}:{i} — {e}\n")
    return entries

def load_logs():
    up = _find_path(USAGE_LOG_PATHS)
    cp = _find_path(CHANGES_LOG_PATHS)
    if not up: raise FileNotFoundError(f"skill_usage_log.jsonl not found. Tried: {[str(p) for p in USAGE_LOG_PATHS]}")
    if not cp: raise FileNotFoundError(f"skill_changes_log.jsonl not found. Tried: {[str(p) for p in CHANGES_LOG_PATHS]}")
    return read_jsonl(up), read_jsonl(cp)

def _elapsed(ts):
    if not ts: return "—"
    try:
        delta = datetime.now(timezone.utc) - datetime.fromisoformat(ts.replace("Z","+00:00"))
        m = int(delta.total_seconds()/60)
        if m < 1: return "just now"
        if m < 60: return f"{m}m ago"
        h = m//60
        if h < 24: return f"{h}h ago"
        return f"{h//24}d ago"
    except: return ts[:10] if ts else "—"

def _build_registry(usage, changes):
    registry = {}
    for ev in usage:
        sid = ev.get("skill_id")
        if not sid: continue
        if sid not in registry:
            registry[sid] = {
                "skill_id":sid,"skill_name":ev.get("skill_name",sid),
                "family":ev.get("family","data"),"project":ev.get("project","system"),
                "agent":ev.get("agent"),"task_type":ev.get("task_type"),
                "times_used":0,"last_used":None,"last_status":None,
                "last_notes":None,"governance":"approved","executions":[],
            }
        sk = registry[sid]
        st = ev.get("status","completed")
        if st in ("completed","running","standby"): sk["times_used"] += 1
        started = ev.get("started_at")
        if started and (sk["last_used"] is None or started > sk["last_used"]):
            sk["last_used"] = started; sk["last_status"] = st; sk["last_notes"] = ev.get("notes")
        sk["executions"].append({"task_ref":ev.get("task_ref"),"status":st,"started_at":started,"ended_at":ev.get("ended_at"),"duration_sec":ev.get("duration_sec")})

    for chg in sorted(changes, key=lambda x: x.get("changed_at","") or ""):
        sid = chg.get("skill_id")
        if not sid: continue
        if sid not in registry:
            rp = chg.get("recommended_projects") or []
            registry[sid] = {
                "skill_id":sid,"skill_name":chg.get("skill_name",sid),
                "family":chg.get("family","data"),
                "project":(rp[0] if rp and isinstance(rp[0],str) else "system"),
                "agent":chg.get("changed_by"),"task_type":chg.get("category"),
                "times_used":0,"last_used":None,"last_status":None,
                "last_notes":None,"governance":"candidate","executions":[],
            }
        sk = registry[sid]
        to_st = chg.get("to_status","")
        if to_st in ("approved","excluded"): sk["governance"] = to_st
        elif to_st == "candidate" and sk["governance"] not in ("approved","excluded"): sk["governance"] = "candidate"
    return registry

def get_active_skills(usage):
    latest = {}
    for ev in usage:
        sid = ev.get("skill_id")
        if not sid: continue
        if sid not in latest or (ev.get("started_at") or "") > (latest[sid].get("started_at") or ""):
            latest[sid] = ev
    now = datetime.now(timezone.utc)
    running, standby = [], []
    for sid, ev in latest.items():
        st = ev.get("status")
        if st not in ("running","standby"): continue
        started = ev.get("started_at")
        el_min = None
        if started:
            try: el_min = int((now - datetime.fromisoformat(started.replace("Z","+00:00"))).total_seconds()/60)
            except: pass
        rec = {
            "id":sid,"skill_name":ev.get("skill_name"),"family":ev.get("family"),
            "family_label":FAMILY_LABELS.get(ev.get("family",""),ev.get("family","")),
            "project":ev.get("project"),
            "project_name":PROJECT_NAMES.get(ev.get("project",""),ev.get("project","")),
            "agent":ev.get("agent"),"task_type":ev.get("task_type"),"task_ref":ev.get("task_ref"),
            "start_time":started,"elapsed_min":el_min,
            "elapsed_label":f"{el_min}m ago" if el_min is not None else "—",
            "status":st,"notes":ev.get("notes"),
        }
        (running if st=="running" else standby).append(rec)
    running.sort(key=lambda x: x["start_time"] or "",reverse=True)
    standby.sort(key=lambda x: x["start_time"] or "",reverse=True)
    return {"section":"active_skills","generated_at":now.isoformat(),
            "running_count":len(running),"standby_count":len(standby),
            "running":running,"standby":standby}

def get_top_skills_by_usage(registry, limit=10):
    ranked = sorted([sk for sk in registry.values() if sk["times_used"]>0],key=lambda x:x["times_used"],reverse=True)
    top_global = [{"rank":i+1,"id":sk["skill_id"],"skill_name":sk["skill_name"],
        "family":sk["family"],"family_label":FAMILY_LABELS.get(sk["family"],sk["family"]),
        "project":sk["project"],"project_name":PROJECT_NAMES.get(sk["project"],sk["project"]),
        "agent":sk["agent"],"task_type":sk["task_type"],"times_used":sk["times_used"],
        "last_used":sk["last_used"],"last_used_label":_elapsed(sk["last_used"]),
        "governance":sk["governance"]} for i,sk in enumerate(ranked[:limit])]
    per_proj = defaultdict(list)
    for sk in ranked: per_proj[sk["project"]].append(sk)
    top_by_project = {proj:{"project_name":PROJECT_NAMES.get(proj,proj),"top_skill":sks[0]["skill_name"],"times_used":sks[0]["times_used"],"agent":sks[0]["agent"]} for proj,sks in per_proj.items()}
    total = sum(sk["times_used"] for sk in registry.values())
    return {"section":"top_skills_by_usage","generated_at":datetime.now(timezone.utc).isoformat(),
            "total_usage_events":total,"skills_with_data":len(ranked),"top_global":top_global,"top_by_project":top_by_project}

def get_top_skill_families(registry):
    fstats = defaultdict(lambda:{"usage_total":0,"skill_count":0,"skills":[],"agents":defaultdict(int)})
    for sk in registry.values():
        f = sk["family"]; u = sk["times_used"]
        fstats[f]["usage_total"]+=u; fstats[f]["skill_count"]+=1; fstats[f]["skills"].append(sk)
        if sk["agent"] and u>0: fstats[f]["agents"][sk["agent"]]+=u
    ranked = sorted(fstats.items(),key=lambda x:x[1]["usage_total"],reverse=True)
    mx = ranked[0][1]["usage_total"] if ranked else 1
    result = []
    for i,(fam,stats) in enumerate(ranked,1):
        top_sk = max(stats["skills"],key=lambda x:x["times_used"],default=None)
        top_ag = max(stats["agents"],key=stats["agents"].get,default=None) if stats["agents"] else None
        result.append({"rank":i,"family":fam,"family_label":FAMILY_LABELS.get(fam,fam),
            "skill_count":stats["skill_count"],"usage_total":stats["usage_total"],
            "usage_pct":round((stats["usage_total"]/mx)*100) if mx else 0,
            "top_skill":top_sk["skill_name"] if top_sk else None,
            "top_skill_uses":top_sk["times_used"] if top_sk else 0,"top_agent":top_ag})
    return {"section":"top_skill_families","generated_at":datetime.now(timezone.utc).isoformat(),"family_count":len(result),"families":result}

def get_new_skills_detected(changes, days=30):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    relevant = {"SKILL_ADDED","SKILL_NOMINATED","SKILL_UPDATED"}
    recent = []
    for chg in changes:
        if chg.get("event_type") not in relevant: continue
        detected = chg.get("changed_at")
        is_recent = True
        try:
            is_recent = datetime.fromisoformat(detected.replace("Z","+00:00")) >= cutoff
        except: pass
        rp = chg.get("recommended_projects") or []
        if rp and isinstance(rp[0],dict): rp = [p.get("project_id",p) for p in rp]
        recent.append({"id":chg.get("skill_id"),"skill_name":chg.get("skill_name"),
            "family":chg.get("family"),"family_label":FAMILY_LABELS.get(chg.get("family",""),chg.get("family","")),
            "category":chg.get("category"),"change_type":chg.get("change_type"),
            "detected_date":detected,"detected_label":_elapsed(detected),
            "recommended_projects":[{"project_id":p,"project_name":PROJECT_NAMES.get(p,p)} for p in rp],
            "review_status":chg.get("review_status"),"added_by":chg.get("changed_by"),
            "notes":chg.get("notes"),"is_recent":is_recent})
    recent.sort(key=lambda x:x["detected_date"] or "",reverse=True)
    return {"section":"new_skills_detected","generated_at":datetime.now(timezone.utc).isoformat(),
            "window_days":days,"total_detected":len(recent),
            "new_count":sum(1 for n in recent if n["change_type"]=="NEW"),
            "update_count":sum(1 for n in recent if n["change_type"]=="UPDATE"),
            "pending_review":sum(1 for n in recent if (n["review_status"] or "").startswith("pending")),
            "skills":recent}

def get_project_skill_distribution(registry):
    by_proj = defaultdict(list)
    for sk in registry.values(): by_proj[sk["project"]].append(sk)
    projects = []
    for proj_id, skills in sorted(by_proj.items(),key=lambda x:PROJECT_NAMES.get(x[0],x[0])):
        fu = defaultdict(int)
        for sk in skills: fu[sk["family"]] += sk["times_used"]
        top_fam = sorted(fu,key=fu.get,reverse=True)[:4]
        top_sks = sorted([sk for sk in skills if sk["times_used"]>0],key=lambda x:x["times_used"],reverse=True)[:5]
        approved = [sk for sk in skills if sk["governance"]=="approved"]
        unused   = [sk for sk in approved if sk["times_used"]==0]
        total    = sum(sk["times_used"] for sk in skills)
        newest   = max((sk for sk in skills if sk["last_used"]),key=lambda x:x["last_used"],default=None)
        projects.append({
            "project_id":proj_id,"project_name":PROJECT_NAMES.get(proj_id,proj_id),
            "total_skills":len(skills),"approved_count":len(approved),
            "candidate_count":len([sk for sk in skills if sk["governance"]=="candidate"]),
            "total_usage_events":total,
            "top_families":[{"family":f,"family_label":FAMILY_LABELS.get(f,f),"usage":fu[f]} for f in top_fam],
            "top_skills":[{"id":sk["skill_id"],"name":sk["skill_name"],"agent":sk["agent"],"times_used":sk["times_used"],"family":sk["family"],"family_label":FAMILY_LABELS.get(sk["family"],"")} for sk in top_sks],
            "newest_skill":newest["skill_name"] if newest else None,
            "unused_approved":len(unused),"unused_approved_names":[sk["skill_name"] for sk in unused],
        })
    grand = sum(p["total_usage_events"] for p in projects)
    most  = max(projects,key=lambda p:p["total_usage_events"],default=None)
    return {"section":"project_skill_distribution","generated_at":datetime.now(timezone.utc).isoformat(),
            "project_count":len(projects),"grand_total_usage":grand,
            "most_active_project":most["project_name"] if most else None,"projects":projects}

def get_full_status(days=30):
    usage, changes = load_logs()
    registry = _build_registry(usage, changes)
    up = _find_path(USAGE_LOG_PATHS); cp = _find_path(CHANGES_LOG_PATHS)
    approved  = sum(1 for sk in registry.values() if sk["governance"]=="approved")
    candidate = sum(1 for sk in registry.values() if sk["governance"]=="candidate")
    excluded  = sum(1 for sk in registry.values() if sk["governance"]=="excluded")
    return {
        "ok":True,"generated_at":datetime.now(timezone.utc).isoformat(),
        "source":{"usage_log":str(up),"changes_log":str(cp),
                  "total_usage_events":len(usage),"total_change_events":len(changes)},
        "meta":{"total_skills":len(registry),"approved":approved,"candidates":candidate,"excluded":excluded},
        "sections":{
            "active_skills":              get_active_skills(usage),
            "top_skills_by_usage":        get_top_skills_by_usage(registry),
            "top_skill_families":         get_top_skill_families(registry),
            "new_skills_detected":        get_new_skills_detected(changes,days=days),
            "project_skill_distribution": get_project_skill_distribution(registry),
        }
    }

def print_summary(data):
    secs=data.get("sections",{}); meta=data.get("meta",{}); src=data.get("source",{})
    print("="*62)
    print("  MISSION CONTROL — SKILLS STATUS")
    print(f"  {data.get('generated_at','')[:19].replace('T',' ')} UTC")
    print("="*62)
    print(f"\n  Sources:")
    print(f"    {src.get('usage_log','?')}")
    print(f"    {src.get('changes_log','?')}")
    print(f"  Events: {src.get('total_usage_events',0)} usage  |  {src.get('total_change_events',0)} changes")
    print(f"\n📊 OVERVIEW — {meta.get('total_skills',0)} skills  ({meta.get('approved',0)} approved · {meta.get('candidates',0)} candidate · {meta.get('excluded',0)} excluded)")
    act=secs.get("active_skills",{})
    print(f"\n⟳  ACTIVE ({act.get('running_count',0)} running · {act.get('standby_count',0)} standby)")
    for sk in act.get("running",[]): print(f"   ▶ {sk['skill_name']:<42} {sk['agent']}  ({sk['elapsed_label']})")
    for sk in act.get("standby",[]): print(f"   ○ {sk['skill_name']:<42} {sk['agent']}  (standby)")
    top=secs.get("top_skills_by_usage",{})
    print(f"\n◬  TOP SKILLS  (total: {top.get('total_usage_events',0):,} events)")
    for sk in top.get("top_global",[])[:5]: print(f"   {sk['rank']}. {sk['skill_name']:<44} {sk['times_used']:>3}x  [{sk.get('project_name','?')}]")
    fam=secs.get("top_skill_families",{})
    print(f"\n◈  FAMILIES")
    for f in fam.get("families",[]): print(f"   {f['rank']}. {f['family_label']:<24} {f['usage_total']:>3}  {'█'*max(1,f['usage_pct']//8)}  top: {(f.get('top_skill') or '?')[:28]}")
    new=secs.get("new_skills_detected",{})
    print(f"\n★  NEW / CHANGES  ({new.get('total_detected',0)} detected · {new.get('pending_review',0)} pending review)")
    for sk in new.get("skills",[])[:6]: print(f"   [{sk['change_type']:<8}] {sk['skill_name']:<38}  {sk['review_status']}  ({sk['detected_label']})")
    dist=secs.get("project_skill_distribution",{})
    print(f"\n⬡  PROJECTS  (most active: {dist.get('most_active_project','—')})")
    for p in dist.get("projects",[]): print(f"   {p['project_name']:<40} {p['total_skills']:>2} skills  {p['total_usage_events']:>4} events")
    print("\n"+"="*62)

def main():
    parser = argparse.ArgumentParser(description="Mission Control — Skills Status")
    parser.add_argument("--section",choices=["active","top","families","new","distribution"])
    parser.add_argument("--pretty",action="store_true")
    parser.add_argument("--summary",action="store_true")
    parser.add_argument("--days",type=int,default=30)
    args = parser.parse_args()
    try:
        if args.summary:
            print_summary(get_full_status(days=args.days)); return
        usage, changes = load_logs()
        registry = _build_registry(usage, changes)
        if args.section:
            sm = {"active":lambda:get_active_skills(usage),"top":lambda:get_top_skills_by_usage(registry),
                  "families":lambda:get_top_skill_families(registry),
                  "new":lambda:get_new_skills_detected(changes,days=args.days),
                  "distribution":lambda:get_project_skill_distribution(registry)}
            output = sm[args.section]()
        else:
            output = get_full_status(days=args.days)
        print(json.dumps(output,indent=2 if args.pretty else None,ensure_ascii=False,default=str))
    except FileNotFoundError as e:
        print(json.dumps({"ok":False,"error":str(e)},indent=2)); sys.exit(1)
    except Exception as e:
        print(json.dumps({"ok":False,"error":str(e),"type":type(e).__name__},indent=2)); sys.exit(1)

if __name__ == "__main__":
    main()
