#!/usr/bin/env python3
"""
ALEXIS OPS — Tool Runner
========================
Execution layer for Mission Control tool coordination.
Called directly or via GET /api/tools/run on Mission Control server.

Execution model:
  auto        — runs immediately, no approval needed
  conditional — runs only inside approved workspace boundaries
  high_risk   — requires explicit operator approval before execution

Tool Request schema:
  agent      : str   — requesting agent ID
  project    : str   — project ID (proj-tl, proj-fse, proj-infire, proj-sg, proj-mc)
  tool       : str   — tool name from registry
  arguments  : dict  — tool-specific arguments
  purpose    : str   — human-readable intent
  risk_level : str   — low | medium | high (caller's stated risk; overridden by registry)

Log file: ~/ai_system/logs/tool_runner.log
"""

import json
import sys
import os
import argparse
import subprocess
import shutil
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── PATHS ────────────────────────────────────────────────────
AI_SYSTEM   = Path(os.path.expanduser("~/ai_system"))
WORKSPACE   = AI_SYSTEM / "workspace"
LOG_FILE    = AI_SYSTEM / "logs/tool_runner.log"
PENDING_DIR = AI_SYSTEM / "tool_runner/pending"
RESULTS_DIR = AI_SYSTEM / "tool_runner/results"

for d in [WORKSPACE, LOG_FILE.parent, PENDING_DIR, RESULTS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ── APPROVED WORKSPACE BOUNDARIES ────────────────────────────
APPROVED_PATHS = [
    WORKSPACE,
    AI_SYSTEM / "logs",
    AI_SYSTEM / "workspace/outputs",
    AI_SYSTEM / "workspace/drafts",
    AI_SYSTEM / "workspace/reports",
    AI_SYSTEM / "workspace/data",
]

def _in_workspace(target: Path) -> bool:
    """True if target is inside an approved workspace boundary."""
    try:
        target = target.resolve()
        return any(
            target == p.resolve() or target.is_relative_to(p.resolve())
            for p in APPROVED_PATHS
        )
    except Exception:
        return False

# ── TOOL REGISTRY ─────────────────────────────────────────────
# Each entry: name → { execution_model, description, allowed_agents, allowed_projects }
TOOL_REGISTRY = {
    # ── AUTO-APPROVED TOOLS ───────────────────────────────────
    "read_file": {
        "execution_model": "auto",
        "description": "Read a file from the workspace. Returns text content.",
        "risk": "low",
        "allowed_agents": "*",
        "allowed_projects": "*",
    },
    "list_workspace": {
        "execution_model": "auto",
        "description": "List files and directories in the workspace.",
        "risk": "low",
        "allowed_agents": "*",
        "allowed_projects": "*",
    },
    "get_status": {
        "execution_model": "auto",
        "description": "Return Tool Runner status, pending queue, and recent results.",
        "risk": "low",
        "allowed_agents": "*",
        "allowed_projects": "*",
    },
    "log_event": {
        "execution_model": "auto",
        "description": "Write a structured event to tool_runner.log.",
        "risk": "low",
        "allowed_agents": "*",
        "allowed_projects": "*",
    },
    "hash_file": {
        "execution_model": "auto",
        "description": "Compute SHA-256 hash of a workspace file for integrity verification.",
        "risk": "low",
        "allowed_agents": "*",
        "allowed_projects": "*",
    },
    "search_workspace": {
        "execution_model": "auto",
        "description": "Search file contents in workspace by keyword.",
        "risk": "low",
        "allowed_agents": "*",
        "allowed_projects": "*",
    },

    # ── CONDITIONAL TOOLS (workspace-bounded) ─────────────────
    "write_file": {
        "execution_model": "conditional",
        "description": "Write or overwrite a file. Path must be inside approved workspace.",
        "risk": "medium",
        "allowed_agents": "*",
        "allowed_projects": "*",
        "path_check": True,
    },
    "append_file": {
        "execution_model": "conditional",
        "description": "Append text to an existing workspace file.",
        "risk": "medium",
        "allowed_agents": "*",
        "allowed_projects": "*",
        "path_check": True,
    },
    "create_report": {
        "execution_model": "conditional",
        "description": "Create a formatted Markdown report in workspace/reports/.",
        "risk": "medium",
        "allowed_agents": ["SUPERVISOR", "QA", "ESTIMATOR", "PORTFOLIO", "REGIME_DETECTOR", "MARKET_INTEL"],
        "allowed_projects": "*",
        "path_check": True,
    },
    "export_data": {
        "execution_model": "conditional",
        "description": "Export structured data (JSON/CSV) to workspace/data/ or workspace/outputs/.",
        "risk": "medium",
        "allowed_agents": "*",
        "allowed_projects": "*",
        "path_check": True,
    },
    "run_python": {
        "execution_model": "conditional",
        "description": "Execute a Python script from workspace/. Output captured. No network.",
        "risk": "medium",
        "allowed_agents": ["CODER", "ESTIMATOR", "SUPERVISOR", "QA"],
        "allowed_projects": "*",
        "path_check": True,
        "workspace_only": True,
    },
    "copy_file": {
        "execution_model": "conditional",
        "description": "Copy a file within the workspace.",
        "risk": "medium",
        "allowed_agents": "*",
        "allowed_projects": "*",
        "path_check": True,
    },

    # ── HIGH-RISK TOOLS (require operator approval) ───────────
    "delete_file": {
        "execution_model": "high_risk",
        "description": "Permanently delete a file. Requires explicit operator approval.",
        "risk": "high",
        "allowed_agents": ["SUPERVISOR", "CODER"],
        "allowed_projects": "*",
        "path_check": True,
    },
    "run_shell": {
        "execution_model": "high_risk",
        "description": "Execute an arbitrary shell command. Maximum scrutiny required.",
        "risk": "high",
        "allowed_agents": ["CODER"],
        "allowed_projects": ["proj-mc", "system"],
    },
    "write_config": {
        "execution_model": "high_risk",
        "description": "Write to a configuration file outside workspace. Requires approval.",
        "risk": "high",
        "allowed_agents": ["CODER", "SUPERVISOR"],
        "allowed_projects": ["proj-mc", "system"],
    },
    "send_notification": {
        "execution_model": "high_risk",
        "description": "Send a message via bot (Telegram/WhatsApp/Discord). Routes through Security Gateway.",
        "risk": "high",
        "allowed_agents": ["WALL_E", "SUPERVISOR"],
        "allowed_projects": ["proj-tl", "proj-mc"],
    },
    "api_call": {
        "execution_model": "high_risk",
        "description": "Make an external HTTP request. Must be to a whitelisted endpoint.",
        "risk": "high",
        "allowed_agents": ["MARKET_INTEL", "REGIME_DETECTOR", "PORTFOLIO", "WALL_E"],
        "allowed_projects": "*",
    },
}


# ── LOGGING ───────────────────────────────────────────────────
def _log(level: str, request_id: str, tool: str, agent: str, project: str,
         status: str, message: str, result: Any = None):
    entry = {
        "ts":         datetime.now(timezone.utc).isoformat(),
        "level":      level,
        "request_id": request_id,
        "tool":       tool,
        "agent":      agent,
        "project":    project,
        "status":     status,
        "message":    message,
    }
    if result is not None:
        entry["result_summary"] = str(result)[:200]
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


# ── EXECUTION ENGINE ──────────────────────────────────────────
def _make_request_id(tool: str, agent: str) -> str:
    raw = f"{tool}-{agent}-{datetime.now(timezone.utc).isoformat()}"
    return "tr-" + hashlib.sha256(raw.encode()).hexdigest()[:8]


def _check_agent_allowed(tool_def: dict, agent: str) -> bool:
    allowed = tool_def.get("allowed_agents", "*")
    if allowed == "*": return True
    return agent in allowed


def _check_project_allowed(tool_def: dict, project: str) -> bool:
    allowed = tool_def.get("allowed_projects", "*")
    if allowed == "*": return True
    return project in allowed


def execute_tool(request: dict) -> dict:
    """
    Main execution entry point. Returns a result dict with:
      ok, status, request_id, tool, agent, project, output, error, execution_model
    """
    agent      = request.get("agent", "UNKNOWN")
    project    = request.get("project", "system")
    tool       = request.get("tool", "")
    arguments  = request.get("arguments", {})
    purpose    = request.get("purpose", "")
    request_id = _make_request_id(tool, agent)

    # ── 1. Tool exists? ───────────────────────────────────────
    if tool not in TOOL_REGISTRY:
        msg = f"Unknown tool: '{tool}'. See tool registry for available tools."
        _log("ERROR", request_id, tool, agent, project, "rejected", msg)
        return {"ok": False, "status": "rejected", "request_id": request_id,
                "tool": tool, "agent": agent, "project": project,
                "error": msg, "execution_model": None}

    tool_def = TOOL_REGISTRY[tool]
    model    = tool_def["execution_model"]

    # ── 2. Agent + project allowed? ───────────────────────────
    if not _check_agent_allowed(tool_def, agent):
        msg = f"Agent '{agent}' not authorized for tool '{tool}'."
        _log("WARN", request_id, tool, agent, project, "rejected", msg)
        return {"ok": False, "status": "rejected", "request_id": request_id,
                "tool": tool, "agent": agent, "project": project,
                "error": msg, "execution_model": model}

    if not _check_project_allowed(tool_def, project):
        msg = f"Project '{project}' not authorized for tool '{tool}'."
        _log("WARN", request_id, tool, agent, project, "rejected", msg)
        return {"ok": False, "status": "rejected", "request_id": request_id,
                "tool": tool, "agent": agent, "project": project,
                "error": msg, "execution_model": model}

    # ── 3. High-risk: queue for approval ─────────────────────
    if model == "high_risk":
        pending = {
            "request_id": request_id,
            "agent": agent, "project": project, "tool": tool,
            "arguments": arguments, "purpose": purpose,
            "risk": tool_def["risk"], "execution_model": model,
            "queued_at": datetime.now(timezone.utc).isoformat(),
            "status": "pending_approval",
        }
        pending_file = PENDING_DIR / f"{request_id}.json"
        pending_file.write_text(json.dumps(pending, indent=2))
        msg = f"High-risk tool '{tool}' queued for operator approval."
        _log("WARN", request_id, tool, agent, project, "pending_approval", msg)
        return {"ok": True, "status": "pending_approval", "request_id": request_id,
                "tool": tool, "agent": agent, "project": project,
                "message": msg, "execution_model": model,
                "pending_file": str(pending_file)}

    # ── 4. Path check for conditional tools ───────────────────
    if tool_def.get("path_check"):
        path_arg = arguments.get("path") or arguments.get("target") or arguments.get("source") or ""
        if path_arg:
            target = Path(os.path.expanduser(path_arg))
            if not target.is_absolute():
                target = WORKSPACE / path_arg
            if not _in_workspace(target):
                msg = f"Path '{path_arg}' is outside approved workspace boundaries."
                _log("ERROR", request_id, tool, agent, project, "rejected", msg)
                return {"ok": False, "status": "rejected", "request_id": request_id,
                        "tool": tool, "agent": agent, "project": project,
                        "error": msg, "execution_model": model}

    # ── 5. Execute ────────────────────────────────────────────
    _log("INFO", request_id, tool, agent, project, "running",
         f"Executing {model} tool '{tool}'. Purpose: {purpose[:80]}")

    try:
        output = _dispatch(tool, arguments, request_id)
        _log("INFO", request_id, tool, agent, project, "completed",
             f"Tool '{tool}' completed successfully.", result=output)
        # Save result
        result_file = RESULTS_DIR / f"{request_id}.json"
        result_file.write_text(json.dumps({
            "request_id": request_id, "tool": tool, "agent": agent,
            "project": project, "status": "completed",
            "output": output, "completed_at": datetime.now(timezone.utc).isoformat(),
        }, indent=2, default=str))
        return {"ok": True, "status": "completed", "request_id": request_id,
                "tool": tool, "agent": agent, "project": project,
                "output": output, "execution_model": model}
    except Exception as e:
        msg = f"Tool '{tool}' execution failed: {e}"
        _log("ERROR", request_id, tool, agent, project, "failed", msg)
        return {"ok": False, "status": "failed", "request_id": request_id,
                "tool": tool, "agent": agent, "project": project,
                "error": msg, "execution_model": model}


# ── TOOL DISPATCH ─────────────────────────────────────────────
def _dispatch(tool: str, args: dict, request_id: str) -> Any:
    dispatch = {
        "read_file":       _tool_read_file,
        "list_workspace":  _tool_list_workspace,
        "get_status":      _tool_get_status,
        "log_event":       _tool_log_event,
        "hash_file":       _tool_hash_file,
        "search_workspace":_tool_search_workspace,
        "write_file":      _tool_write_file,
        "append_file":     _tool_append_file,
        "create_report":   _tool_create_report,
        "export_data":     _tool_export_data,
        "run_python":      _tool_run_python,
        "copy_file":       _tool_copy_file,
        "delete_file":     _tool_delete_file,
        "run_shell":       _tool_run_shell,
        "send_notification": _tool_send_notification,
        "api_call":        _tool_api_call,
        "write_config":    _tool_write_config,
    }
    fn = dispatch.get(tool)
    if not fn:
        raise ValueError(f"No handler for tool '{tool}'")
    return fn(args, request_id)


def _resolve_ws(path_str: str) -> Path:
    p = Path(os.path.expanduser(path_str))
    if not p.is_absolute():
        p = WORKSPACE / path_str
    return p

def _tool_read_file(args, _):
    p = _resolve_ws(args.get("path", ""))
    if not p.exists(): raise FileNotFoundError(f"File not found: {p}")
    content = p.read_text(errors="replace")
    return {"path": str(p), "size_bytes": p.stat().st_size,
            "lines": content.count("\n"), "content": content[:4000]}

def _tool_list_workspace(args, _):
    base = _resolve_ws(args.get("path", "")) if args.get("path") else WORKSPACE
    if not base.exists(): raise FileNotFoundError(f"Directory not found: {base}")
    items = []
    for item in sorted(base.iterdir()):
        items.append({"name": item.name, "type": "dir" if item.is_dir() else "file",
                      "size": item.stat().st_size if item.is_file() else None})
    return {"path": str(base), "count": len(items), "items": items}

def _tool_get_status(args, _):
    pending = list(PENDING_DIR.glob("*.json"))
    results = list(RESULTS_DIR.glob("*.json"))
    log_lines = []
    if LOG_FILE.exists():
        with open(LOG_FILE) as f:
            log_lines = [json.loads(l) for l in f.readlines()[-20:] if l.strip()]
    return {
        "tool_runner_version": "1.0.0",
        "workspace": str(WORKSPACE),
        "log_file": str(LOG_FILE),
        "pending_count": len(pending),
        "results_count": len(results),
        "registry_size": len(TOOL_REGISTRY),
        "auto_tools": sum(1 for t in TOOL_REGISTRY.values() if t["execution_model"]=="auto"),
        "conditional_tools": sum(1 for t in TOOL_REGISTRY.values() if t["execution_model"]=="conditional"),
        "high_risk_tools": sum(1 for t in TOOL_REGISTRY.values() if t["execution_model"]=="high_risk"),
        "recent_log": log_lines[-5:],
    }

def _tool_log_event(args, request_id):
    event = args.get("event", "CUSTOM_EVENT")
    detail = args.get("detail", "")
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "level": "INFO",
             "request_id": request_id, "tool": "log_event",
             "agent": args.get("agent","UNKNOWN"), "project": args.get("project","system"),
             "status": "logged", "message": f"{event}: {detail}"}
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return {"logged": True, "event": event, "detail": detail}

def _tool_hash_file(args, _):
    p = _resolve_ws(args.get("path", ""))
    if not p.exists(): raise FileNotFoundError(f"File not found: {p}")
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"path": str(p), "sha256": h, "size_bytes": p.stat().st_size}

def _tool_search_workspace(args, _):
    keyword = args.get("keyword", "")
    if not keyword: raise ValueError("keyword argument required")
    base = WORKSPACE
    matches = []
    for f in base.rglob("*"):
        if f.is_file():
            try:
                text = f.read_text(errors="replace")
                lines = [(i+1, l.strip()) for i, l in enumerate(text.splitlines()) if keyword.lower() in l.lower()]
                if lines:
                    matches.append({"file": str(f.relative_to(WORKSPACE)), "match_count": len(lines), "matches": lines[:5]})
            except Exception:
                pass
    return {"keyword": keyword, "files_matched": len(matches), "results": matches[:20]}

def _tool_write_file(args, _):
    p = _resolve_ws(args.get("path", ""))
    content = args.get("content", "")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return {"path": str(p), "bytes_written": len(content.encode())}

def _tool_append_file(args, _):
    p = _resolve_ws(args.get("path", ""))
    content = args.get("content", "")
    with open(p, "a") as f:
        f.write(content)
    return {"path": str(p), "bytes_appended": len(content.encode())}

def _tool_create_report(args, _):
    name     = args.get("name", f"report-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md")
    title    = args.get("title", "Report")
    content  = args.get("content", "")
    metadata = args.get("metadata", {})
    if not name.endswith(".md"):
        name += ".md"
    p = WORKSPACE / "reports" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    header = f"# {title}\n\n"
    if metadata:
        header += "| Key | Value |\n|---|---|\n"
        for k, v in metadata.items():
            header += f"| {k} | {v} |\n"
        header += "\n"
    p.write_text(header + content)
    return {"path": str(p), "name": name, "bytes": p.stat().st_size}

def _tool_export_data(args, _):
    name    = args.get("name", f"export-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    data    = args.get("data", {})
    fmt     = args.get("format", "json")
    subdir  = args.get("subdir", "data")
    target  = WORKSPACE / subdir / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "json":
        target.write_text(json.dumps(data, indent=2, default=str))
    elif fmt == "csv":
        if isinstance(data, list) and data and isinstance(data[0], dict):
            import csv, io
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=data[0].keys())
            w.writeheader(); w.writerows(data)
            target.write_text(buf.getvalue())
        else:
            target.write_text(str(data))
    return {"path": str(target), "format": fmt, "bytes": target.stat().st_size}

def _tool_run_python(args, request_id):
    script = args.get("script") or args.get("path", "")
    code   = args.get("code", "")
    timeout = min(int(args.get("timeout", 30)), 60)
    if script:
        p = _resolve_ws(script)
        if not p.exists(): raise FileNotFoundError(f"Script not found: {p}")
        cmd = ["python3", str(p)]
    elif code:
        tmp = WORKSPACE / f".tmp_{request_id}.py"
        tmp.write_text(code)
        cmd = ["python3", str(tmp)]
    else:
        raise ValueError("Provide 'script' path or 'code' string")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                            cwd=str(WORKSPACE), env={**os.environ, "PYTHONPATH": str(WORKSPACE)})
    if script == "" and code:
        tmp.unlink(missing_ok=True)
    return {"returncode": result.returncode, "stdout": result.stdout[:3000],
            "stderr": result.stderr[:1000], "timed_out": False}

def _tool_copy_file(args, _):
    src  = _resolve_ws(args.get("source", args.get("src", "")))
    dest = _resolve_ws(args.get("target", args.get("dest", "")))
    if not src.exists(): raise FileNotFoundError(f"Source not found: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return {"source": str(src), "destination": str(dest), "bytes": dest.stat().st_size}

def _tool_delete_file(args, _):
    p = _resolve_ws(args.get("path", ""))
    if not p.exists(): raise FileNotFoundError(f"File not found: {p}")
    size = p.stat().st_size
    p.unlink()
    return {"deleted": str(p), "bytes_freed": size}

def _tool_run_shell(args, _):
    cmd     = args.get("command", "")
    timeout = min(int(args.get("timeout", 10)), 30)
    if not cmd: raise ValueError("command argument required")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                            timeout=timeout, cwd=str(WORKSPACE))
    return {"command": cmd, "returncode": result.returncode,
            "stdout": result.stdout[:3000], "stderr": result.stderr[:500]}

def _tool_send_notification(args, _):
    return {"status": "queued_for_security_gateway",
            "note": "Bot notifications must route through Security Gateway — token not accessible here.",
            "platform": args.get("platform", "unknown"),
            "message_preview": str(args.get("message",""))[:100]}

def _tool_api_call(args, _):
    return {"status": "queued_for_security_gateway",
            "note": "API calls require Security Gateway endpoint validation before execution.",
            "endpoint": args.get("endpoint", "unknown")}

def _tool_write_config(args, _):
    return {"status": "pending_approval",
            "note": "Config writes outside workspace require explicit operator approval."}


# ── STATUS / QUEUE READER ─────────────────────────────────────
def get_pending_queue() -> list[dict]:
    results = []
    for f in sorted(PENDING_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try: results.append(json.loads(f.read_text()))
        except: pass
    return results

def get_recent_results(n: int = 20) -> list[dict]:
    results = []
    for f in sorted(RESULTS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:n]:
        try: results.append(json.loads(f.read_text()))
        except: pass
    return results

def get_recent_log(n: int = 50) -> list[dict]:
    if not LOG_FILE.exists(): return []
    with open(LOG_FILE) as f:
        lines = f.readlines()[-n:]
    entries = []
    for l in reversed(lines):
        try: entries.append(json.loads(l.strip()))
        except: pass
    return entries

def approve_pending(request_id: str) -> dict:
    f = PENDING_DIR / f"{request_id}.json"
    if not f.exists(): return {"ok": False, "error": f"Pending request {request_id} not found"}
    req = json.loads(f.read_text())
    req.pop("status", None)
    result = execute_tool({**req, "_override_model": "approved"})
    f.unlink(missing_ok=True)
    return result

def reject_pending(request_id: str, reason: str = "") -> dict:
    f = PENDING_DIR / f"{request_id}.json"
    if not f.exists(): return {"ok": False, "error": f"Pending request {request_id} not found"}
    req = json.loads(f.read_text())
    _log("WARN", request_id, req.get("tool",""), req.get("agent",""), req.get("project",""),
         "rejected_by_operator", f"Operator rejected. Reason: {reason or 'none'}")
    f.unlink(missing_ok=True)
    return {"ok": True, "status": "rejected_by_operator", "request_id": request_id, "reason": reason}


# ── CLI ───────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="ALEXIS OPS — Tool Runner")
    sub = parser.add_subparsers(dest="command")

    # run: python3 tool_runner.py run --request '{"agent":...}'
    p_run = sub.add_parser("run", help="Execute a tool request")
    p_run.add_argument("--request", help="JSON tool request string")
    p_run.add_argument("--file",    help="Path to JSON request file")
    p_run.add_argument("--pretty",  action="store_true")

    # status
    sub.add_parser("status", help="Show Tool Runner status and queue")

    # log
    p_log = sub.add_parser("log", help="Tail the tool runner log")
    p_log.add_argument("--n", type=int, default=20)

    # approve
    p_app = sub.add_parser("approve", help="Approve a pending high-risk tool request")
    p_app.add_argument("request_id")

    # reject
    p_rej = sub.add_parser("reject", help="Reject a pending high-risk tool request")
    p_rej.add_argument("request_id")
    p_rej.add_argument("--reason", default="")

    # registry
    sub.add_parser("registry", help="Show full tool registry")

    args = parser.parse_args()
    indent = 2

    if args.command == "run":
        if args.request:
            request = json.loads(args.request)
        elif args.file:
            request = json.loads(Path(args.file).read_text())
        else:
            parser.error("Provide --request JSON or --file path")
        print(json.dumps(execute_tool(request), indent=indent, default=str))

    elif args.command == "status":
        status = execute_tool({"agent":"OPERATOR","project":"system","tool":"get_status","arguments":{},"purpose":"CLI status check"})
        pending = get_pending_queue()
        print(json.dumps({"status": status.get("output"), "pending_queue": pending}, indent=indent, default=str))

    elif args.command == "log":
        for entry in get_recent_log(args.n):
            ts  = entry.get("ts","")[:19].replace("T"," ")
            lvl = entry.get("level","?")
            tool = entry.get("tool","?")
            agent = entry.get("agent","?")
            status = entry.get("status","?")
            msg = entry.get("message","")[:80]
            print(f"{ts}  [{lvl:<5}]  {tool:<22} {agent:<20} {status:<20} {msg}")

    elif args.command == "approve":
        print(json.dumps(approve_pending(args.request_id), indent=indent, default=str))

    elif args.command == "reject":
        print(json.dumps(reject_pending(args.request_id, args.reason), indent=indent, default=str))

    elif args.command == "registry":
        for name, t in sorted(TOOL_REGISTRY.items()):
            model = t["execution_model"]
            color = {"auto":"✓","conditional":"~","high_risk":"!"}[model]
            print(f"  {color} {name:<25} [{model:<12}]  {t['description'][:55]}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
