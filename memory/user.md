# ALEXIS OPS — User Context (Alexis)
> Read this at the start of every session. Update with new context as it emerges.

---

## WHO IS ALEXIS

- Fire protection engineer by profession (NFPA 13, sprinkler systems, hazard classification)
- Crypto trader / researcher (BTC/ETH focus, simulation-first approach)
- Developer / builder (building ALEXIS OPS Mission Control autonomously)
- Bilingual: Spanish (primary) / English
- Operational style: builds fast, iterates fast, wants things done — not discussed

---

## ACTIVE SYSTEM: ALEXIS OPS

**Mission Control** is Alexis's personal autonomous operations system. It's a local Node.js dashboard running at `http://localhost:3000` that coordinates multiple AI agent projects.

### Quick Start (after download)
```bash
tar -xzf mission-control-vX.tar.gz
cd mission-control
npm install
npm start
# → http://localhost:3000
```

### Required Setup
1. Open Mission Control → API Vault tab
2. Add key with **provider: "Anthropic"** → enables all AI features
3. Model used everywhere: `claude-sonnet-4-20250514`

---

## CURRENT PROJECT STATE (as of v16)

### What's Built
- **Dashboard / Mission Control** — Coordination layer, 4 projects, workflows, pending ops, AI status reports
- **Trading League tab** with 10 modules:
  - Capital Curve, Trader Evolution Tree, Strategy Intelligence Map
  - Market Intelligence Feed, AI Trade Simulator, Real Trading Safety Gate
  - Market Regime Detector, Execution Guard, Liquidity Radar, Strategy Discovery Engine
- **Security Gateway** — Full agent operation routing with 5-step validation, 6 operation categories, bot commands
- **Other tabs** — Projects, Agents, Timeline, Blockers, Event Logs, AI Chat, API Vault

### What's Pending / Next
- [ ] Resolve SG delayed ops: sg008 (OPEN_CLAW /etc/ write), sg012 (Telegram channel)
- [ ] Whitelist `api.wix.com` in Security Gateway → unblocks Infire publishing
- [ ] Complete FSE NFPA 13 2025 spec update
- [ ] PostgreSQL migration (when going to production)
- [ ] Live trading data feed integration (currently mock/seed data)
- [ ] WhatsApp Twilio backend webhook (`/api/whatsapp`)
- [ ] Authentication / login system
- [ ] Real agent heartbeat integration

---

## KEY NUMBERS TO REMEMBER

| Thing | Value |
|---|---|
| Dashboard URL | http://localhost:3000 |
| Current version | v16 |
| server.js lines | ~2,217 |
| index.html lines | ~9,688 |
| Data file | data.json (single file, all state) |
| Trading capital | $59,050 (Gen 3, Week 2) |
| SG requests processed | 51 |
| Estimates generated (FSE) | 47 |
| Agents registered | 12 |
| Whitelisted endpoints | 12 |

---

## CONTEXT TO ALWAYS CARRY

1. **Monitoring Only** — no real capital is ever at risk in Trading League
2. **Security First** — every external op goes through Security Gateway, no exceptions
3. **Single file delivery** — always package as `.tar.gz` so Alexis can extract and run immediately
4. **Spanish** — Alexis writes in Spanish, respond in Spanish unless the context is clearly technical/code
5. **Build don't discuss** — when a task is clear, execute it directly
6. **data.json** is the source of truth — always check it before building new features to avoid conflicts
7. **WS broadcast** after every state change — dashboard updates in real time
