# ALEXIS OPS — People, Agents & Projects
> Read this at the start of every session. Update when agents/projects change.

---

## OPERATOR

- **Name:** Alexis
- **Role:** Owner and operator of ALEXIS OPS Mission Control
- **Occupation:** Fire protection engineer + crypto trader + developer
- **Communication:** Direct, technical, prefers concise responses
- **Stack familiarity:** Node.js, Python, REST APIs, JSON, HTML/CSS/JS

---

## MISSION CONTROL SYSTEM AGENTS

| Agent ID | Name | Clearance | Project | Status | Role |
|---|---|---|---|---|---|
| a1 | SUPERVISOR | elevated | System | active | Oversees all workflows and agent coordination |
| a2 | ROUTER | elevated | System | active | Routes tasks between agents and projects |
| a3 | MEMORY-MGR | elevated | System | waiting | Manages persistent memory and context |
| a4 | ESTIMATOR | elevated | Fire Sprinkler Estimator | active | NFPA 13 calculations and estimates |
| a5 | TRADER | standard | Trading League | blocked | Manages trade evaluation (not live) |
| a6 | PORTFOLIO | elevated | Infire Portfolio | active | Blog and portfolio content management |
| a7 | CODER | elevated | System | reviewing | Code generation, fixes, deployments |
| a8 | QA | elevated | System | active | Quality assurance and validation |

---

## TRADING LEAGUE AGENTS (La Logia)

| Trader | Strategy | Clearance | Win Rate | Status | Notes |
|---|---|---|---|---|---|
| NEXUS | Momentum Breakout | standard | 72% | active | Top performer Gen 3, BTC focus |
| SENTINEL | Range Reversal | standard | 65% | active | ETH specialist, conservative |
| ATLAS | Trend Following | standard | 58% | active | Restricted — capital violation history |
| CIPHER | Volatility Scalping | standard | 61% | active | Attempted unauthorized script exec |
| VORTEX | Multi-Asset Swing | standard | 68% | active | BTC/ETH, highest risk tolerance |

**System agents (Trading League):**
- RISK_MANAGER (elevated) — enforces constitution rules
- QA_CRITIC (elevated) — validates trade quality
- EXECUTION_GUARD (elevated) — 10-check trade validation pipeline
- MARKET_INTEL (elevated) — price feeds and sentiment data
- REGIME_DETECTOR (elevated) — BTC/ETH market regime classification

**Infrastructure agents:**
- WALL_E (elevated) — automation tasks, file writes to approved paths
- OPEN_CLAW (standard) — execution agent, pending config write resolution

**Security:**
- SECURITY_GUARDIAN (admin) — Security Gateway, all operation routing

---

## CONNECTED PROJECTS

### Trader League — La Logia (`proj-tl`)
- **Icon:** ◬ · **Color:** Amber
- **Status:** Active · Gen 3, Week 2
- **Capital:** $59,050 (started $50,000)
- **Mode:** Simulation / monitoring only
- **Modules:** Capital Curve, Execution Guard, Market Regime Detector, Liquidity Radar, Strategy Discovery, AI Trade Simulator, Market Intelligence Feed, Real Trading Safety Gate
- **Constitution:** Max $25/trader, max 10% exposure/trade, SL mandatory, max 3x leverage, min 2:1 RR, max 3 trades/week

### Infire Portfolio / Blog (`proj-infire`)
- **Icon:** ◈ · **Color:** Cyan
- **Status:** Active · Health: DEGRADED
- **Platform:** Wix
- **Issue:** OAuth token expired — content sync paused
- **Pending:** Add `api.wix.com` to Security Gateway whitelist

### Fire Sprinkler Estimator (`proj-fse`)
- **Icon:** ⬡ · **Color:** Green
- **Status:** Active · Health: Nominal
- **Standard:** NFPA 13-2022 (2025 addendum in progress)
- **Metrics:** 47 estimates generated, 96.2% accuracy
- **Pending:** NFPA 13 spec update completion

### Security Guardian (`proj-sg`)
- **Icon:** ⊛ · **Color:** Rose
- **Status:** Active · Health: Nominal
- **Version:** v2.0.0
- **Stats:** 51 requests, 3 critical blocks, 2 delayed pending override

---

## EXTERNAL SERVICES

| Service | Endpoint | Whitelisted | Used By |
|---|---|---|---|
| Binance Spot | api.binance.com | ✓ | MARKET_INTEL, traders |
| Binance Futures | fapi.binance.com | ✓ | MARKET_INTEL |
| Alternative.me | api.alternative.me | ✓ | MARKET_INTEL (Fear & Greed) |
| CoinGecko | api.coingecko.com | ✓ | MARKET_INTEL |
| Anthropic | api.anthropic.com | ✓ | REGIME_DETECTOR, EXECUTION_GUARD, MC |
| Glassnode | api.glassnode.com | ✓ | MARKET_INTEL (on-chain) |
| Kraken | api.kraken.com | ✓ | Price feeds |
| Blockchain.info | blockchain.info | ✓ | BTC on-chain |
| Twilio | api.twilio.com | ✓ | WALL_E (WhatsApp) |
| Telegram | api.telegram.org | ✓ | Bot notifications |
| Discord | discord.com/api/v10 | ✓ | Read-only monitoring |
| **Wix** | **api.wix.com** | **✗ PENDING** | PORTFOLIO (needs whitelist) |
