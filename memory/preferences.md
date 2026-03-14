# ALEXIS OPS — Preferences & Standards
> Read this at the start of every session. Update when patterns change.

---

## CODE STYLE

### JavaScript
- **No frameworks** — vanilla JS only for the dashboard frontend
- **Async/await** preferred over `.then()` chains
- **Variable naming:** camelCase, descriptive (e.g., `sgExpandedCards`, `mcCurrentFilter`)
- **Function naming:** verb + subject (e.g., `renderSGQueue`, `buildSGOpCard`, `setSgFilter`)
- **State:** Single global `state` object with namespaced keys (`state.trading`, `state.securityGateway`, `state.missionControl`)
- **DB access:** Direct `db.namespace` reads, always call `saveDb()` + `broadcast()` after writes
- **No `console.log` spam** — only `console.error` for failures

### HTML/CSS
- **Inline styles** preferred for one-off component styles
- **CSS classes** only for reusable patterns (tabs, cards, badges, rows)
- **No external CSS files** — all styles in `<style>` block inside index.html
- **CSS variables** always: `var(--text)`, `var(--card)`, `var(--muted)`, `var(--border)`, etc.
- **Font sizes:** Labels 7-8px, body 10-11px, values 9-12px, titles 20-28px
- **All mono text** uses `font-family:'JetBrains Mono',monospace`
- **Border opacity pattern:** `rgba(color, .07-.3)` — subtle by default

### Server (Node.js)
- **Express routes** grouped by domain with comment headers: `// ─── DOMAIN ENDPOINTS ──`
- **Always call** `saveDb()` and `broadcast({ type: 'X_UPDATE', data: db.x })` after state mutations
- **Error responses** always include `{ error: 'description' }` with appropriate HTTP status
- **Async AI calls** — always respond to HTTP first, then run async, broadcast when done
- **No blocking operations** in main thread

---

## UI/UX PATTERNS

### Card Structure
```
┌─ Card ──────────────────────────────────────┐
│ [LABEL - mono 8px uppercase tracking]        │
│ VALUE (mono 20-22px bold, colored)           │
│ sub-label (mono 8px muted)                   │
└──────────────────────────────────────────────┘
```

### Module Structure (every major section)
1. Header with title + subtitle + action buttons
2. Stats row (6 cards, grid-template-columns:repeat(6,1fr))
3. View tabs (`.module-tab` pattern, active state colored)
4. Filter row if applicable (`.module-filter` pattern)
5. Content area (dynamic render by current view)

### Expandable Cards
- Always use a `Set` to track open IDs: `let expandedCards = new Set()`
- Toggle fn: `if (set.has(id)) set.delete(id); else set.add(id);`
- Re-render the whole list on toggle (fast enough, keeps code simple)
- Show `▲` / `▼` indicator in top-right of card header

### Status Badges
- Approved/Nominal → green (`rgba(16,185,129,...)`)
- Rejected/Critical/Blocked → rose (`rgba(244,63,94,...)`)
- Delayed/Warning/Degraded → amber (`rgba(245,158,11,...)`)
- Pending/Info → violet (`rgba(124,58,237,...)`)
- Always: `font-family:'JetBrains Mono',monospace; font-size:7-8px; font-weight:700; padding:2px 6-8px; border-radius:3-4px`

### Progress Bars
```css
.progress-track { height:3px; background:rgba(255,255,255,.06); border-radius:2px; overflow:hidden; }
.progress-bar   { height:100%; border-radius:2px; transition:width .4s ease; }
```

### AI Result Panels
- Background: `rgba(124,58,237,.06)` with `border:1px solid rgba(124,58,237,.15)`
- Header label: violet, 7px uppercase mono
- Content: 10-11px, `var(--text2)`, line-height 1.6-1.75
- Always show "⟳ Generating..." state while awaiting

---

## WORKFLOW PREFERENCES

### Building New Modules
1. Seed data first in `data.json` with realistic values
2. Server endpoints second (`GET`, `POST`, `PATCH` minimum)
3. HTML structure (divs with IDs, no content)
4. CSS classes (reusable patterns only)
5. JS render functions (master → sub-renders)
6. Wire into `renderAll()` and WS handler
7. Final check: `N/N checks passed` validation script
8. Package as `mission-control-vX.tar.gz`

### Versioning
- Each major feature = new version number
- Always package as `mission-control-vX.tar.gz` and copy to `/mnt/user-data/outputs/`
- Version history: v10 (base), v11 (SDE), v12 (LR), v13 (EG+MRD), v14 (SG v1), v15 (SG v2), v16 (MC init)

### Validation Before Packaging
```python
# Always run this check before packaging
checks = [html_checks, css_checks, js_checks, server_checks, wiring_checks]
# Must hit N/N — zero missing
```

---

## SECURITY PREFERENCES

- **Never hardcode API keys** — always read from `db.apiKeys` vault
- **Always respond HTTP first** on async AI endpoints, then broadcast
- **Credential pattern:** `db.apiKeys.find(k => k.provider==='Anthropic' && k.key?.length>20)?.key`
- **All external ops** must route through Security Gateway endpoint validation
- **Lockdown check** at top of every POST that triggers external ops

---

## RESPONSE PREFERENCES (for Claude)

- Speak Spanish when Alexis writes in Spanish
- Be direct, no fluff — if something is broken, say it immediately
- Show line counts and check results when delivering builds
- Present files immediately after creation — don't make Alexis ask
- When something is important and missing, add it without being asked
- Prefer building over explaining when the task is clear
