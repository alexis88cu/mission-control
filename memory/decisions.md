# ALEXIS OPS — Decisions Log
> Read this at the start of every session. Update when new decisions are made.

---

## ARCHITECTURE DECISIONS

### AD-001 · Mission Control Stack
- **Decision:** Node.js + Express + WebSocket backend, vanilla JS + HTML frontend, no React
- **Reason:** Lightweight, fast to iterate, runs locally without build tools
- **Date:** March 2025
- **Status:** Final

### AD-002 · Data Persistence
- **Decision:** Single `data.json` file for all project state (no database yet)
- **Reason:** Speed of development, easy to inspect/debug, no infra overhead
- **Migration path:** PostgreSQL planned when moving to production
- **Status:** Active (dev phase)

### AD-003 · Security Gateway Routing
- **Decision:** ALL agent external operations must pass through Security Gateway before execution
- **Reason:** Prevent credential exposure, unapproved API calls, unauthorized file writes
- **Enforced for:** Internet access, API calls, file system writes, script execution, credential access, bot commands
- **Status:** Enforced — no exceptions

### AD-004 · Trading League — Monitoring Only
- **Decision:** Traders operate in simulation mode only. No real capital at risk.
- **Reason:** System still in development. Live trading requires production-grade infra + auth.
- **Max capital per trader (when live):** $25 USDT
- **Status:** Enforced — MONITORING ONLY banner always visible

### AD-005 · Claude Model for AI Features
- **Decision:** Use `claude-sonnet-4-20250514` for all in-app AI calls (regime analysis, trade validation, security reviews, status reports)
- **Reason:** Best balance of speed, quality, and cost for real-time dashboard use
- **API key source:** API Vault in Mission Control → provider: "Anthropic"
- **Status:** Active

### AD-006 · Bot Token Security
- **Decision:** Bot tokens (Telegram, WhatsApp, Discord) are NEVER passed to agents
- **Reason:** Prevent token leakage through agent memory or logs
- **Mechanism:** Security Gateway injects credentials on behalf of the system
- **Status:** Enforced

### AD-007 · Mission Control as Coordination Layer
- **Decision:** Dashboard tab = Mission Control (replaced old placeholder). It coordinates all 4 projects.
- **Connected projects:** Trader League, Infire Portfolio, Fire Sprinkler Estimator, Security Guardian
- **Status:** Active (v16)

---

## DESIGN DECISIONS

### DD-001 · Color System
- Violet `#7c3aed` → System / Mission Control
- Amber `#f59e0b` → Trading / Warnings
- Cyan `#06b6d4` → Data / Intelligence
- Rose `#f43f5e` → Security / Danger
- Green `#10b981` → Approved / Success
- All components use CSS variables (`--violet-b`, `--amber-b`, etc.)

### DD-002 · Font System
- `'JetBrains Mono'` → All labels, badges, metrics, code
- `'Syne'` → Page titles and section headers only
- System sans-serif → Body text and descriptions

### DD-003 · Component Pattern
- Every major module has: header → stats row → view tabs → content area
- Cards use `var(--card)` background with `rgba(255,255,255,.07)` border
- Expandable cards use `Set()` for tracking open state (e.g., `sgExpandedCards`)

---

## REJECTED DECISIONS

- ~~React for frontend~~ → Too heavy for local dashboard, vanilla JS is faster to ship
- ~~Separate CSS file~~ → Inline `<style>` in index.html for easier single-file delivery
- ~~Multiple JSON files~~ → One `data.json` keeps state sync simple
