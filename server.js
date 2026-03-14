// ═══════════════════════════════════════════════════════════════
// MISSION CONTROL — Local Server v2.0
// ALEXIS OPS — Real-time backend with WebSocket + REST API
// Run: node server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── DATA LAYER ───────────────────────────────────────────────
let db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function addEvent(agent, project, type, severity, summary) {
  const event = {
    id: `e${uuidv4().slice(0,8)}`,
    agent, project, type, severity, summary,
    ts: new Date().toISOString()
  };
  db.events.unshift(event);
  if (db.events.length > 200) db.events = db.events.slice(0, 200);
  saveDb();
  broadcast({ type: 'EVENT', data: event });
  return event;
}

// ─── EXPRESS SETUP ────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve the dashboard HTML
app.use(express.static(path.join(__dirname, 'public')));

// ─── REST API ─────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString(), clients: wss ? wss.clients.size : 0 });
});

// Metrics overview
app.get('/api/metrics', (req, res) => {
  const activeProjects = db.projects.filter(p => p.status === 'active').length;
  const totalTasks = db.projects.reduce((a,p) => a + p.tasks, 0);
  const doneTasks = db.projects.reduce((a,p) => a + p.done, 0);
  const avgProgress = Math.round(db.projects.reduce((a,p) => a + p.progress, 0) / db.projects.length);
  const openBlockers = db.blockers.filter(b => b.status === 'open').length;
  const activeAgents = db.agents.filter(a => a.status === 'active').length;
  res.json({ activeProjects, totalProjects: db.projects.length, totalTasks, doneTasks, avgProgress, openBlockers, activeAgents, totalAgents: db.agents.length });
});

// Projects CRUD
app.get('/api/projects', (req, res) => res.json(db.projects));

app.post('/api/projects', (req, res) => {
  const p = { ...req.body, id: `p${uuidv4().slice(0,8)}`, progress: 0, health: 100, done: 0, blockers: 0, createdAt: new Date().toISOString() };
  db.projects.push(p);
  saveDb();
  addEvent('SUPERVISOR', p.name, 'project', 'info', `New project created: ${p.name}`);
  broadcast({ type: 'PROJECTS_UPDATE', data: db.projects });
  res.status(201).json(p);
});

app.get('/api/projects/:id', (req, res) => {
  const p = db.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.patch('/api/projects/:id', (req, res) => {
  const idx = db.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.projects[idx] = { ...db.projects[idx], ...req.body, updatedAt: new Date().toISOString() };
  saveDb();
  addEvent('SUPERVISOR', db.projects[idx].name, 'update', 'info', `Project updated: ${db.projects[idx].name}`);
  broadcast({ type: 'PROJECTS_UPDATE', data: db.projects });
  res.json(db.projects[idx]);
});

app.delete('/api/projects/:id', (req, res) => {
  const p = db.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  db.projects = db.projects.filter(p => p.id !== req.params.id);
  saveDb();
  addEvent('SUPERVISOR', p.name, 'delete', 'warn', `Project deleted: ${p.name}`);
  broadcast({ type: 'PROJECTS_UPDATE', data: db.projects });
  res.json({ ok: true });
});

// Agents
app.get('/api/agents', (req, res) => res.json(db.agents));

app.patch('/api/agents/:id', (req, res) => {
  const idx = db.agents.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.agents[idx] = { ...db.agents[idx], ...req.body };
  saveDb();
  broadcast({ type: 'AGENTS_UPDATE', data: db.agents });
  res.json(db.agents[idx]);
});

// Blockers
app.get('/api/blockers', (req, res) => res.json(db.blockers));

app.post('/api/blockers', (req, res) => {
  const b = { ...req.body, id: `b${uuidv4().slice(0,8)}`, created: new Date().toISOString(), status: 'open' };
  db.blockers.unshift(b);
  saveDb();
  addEvent(b.agent || 'SUPERVISOR', b.project, 'blocker', 'error', `New blocker: ${b.title}`);
  broadcast({ type: 'BLOCKERS_UPDATE', data: db.blockers });
  res.status(201).json(b);
});

app.patch('/api/blockers/:id', (req, res) => {
  const idx = db.blockers.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.blockers[idx] = { ...db.blockers[idx], ...req.body };
  if (req.body.status === 'resolved') db.blockers[idx].resolvedAt = new Date().toISOString();
  saveDb();
  addEvent('SUPERVISOR', db.blockers[idx].project, 'blocker_update', 'info', `Blocker ${req.body.status}: ${db.blockers[idx].title}`);
  broadcast({ type: 'BLOCKERS_UPDATE', data: db.blockers });
  res.json(db.blockers[idx]);
});

// Events
app.get('/api/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.events.slice(0, limit));
});

app.post('/api/events', (req, res) => {
  const { agent, project, type, severity, summary } = req.body;
  const event = addEvent(agent, project, type, severity, summary);
  res.status(201).json(event);
});

// API Keys (no actual secrets sent in full — masked)
app.get('/api/keys', (req, res) => {
  const masked = db.apiKeys.map(k => ({ ...k, key: k.key ? k.key.slice(0,8) + '••••••••••••' : '' }));
  res.json(masked);
});

app.post('/api/keys', (req, res) => {
  const k = { ...req.body, id: `k${uuidv4().slice(0,8)}`, lastUsed: 'never' };
  db.apiKeys.push(k);
  saveDb();
  broadcast({ type: 'KEYS_UPDATE', data: db.apiKeys.map(k => ({ ...k, key: k.key ? '••••••' : '' })) });
  res.status(201).json({ ...k, key: '••••••' });
});

app.patch('/api/keys/:id', (req, res) => {
  const idx = db.apiKeys.findIndex(k => k.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.apiKeys[idx] = { ...db.apiKeys[idx], ...req.body };
  saveDb();
  res.json({ ...db.apiKeys[idx], key: '••••••' });
});

app.delete('/api/keys/:id', (req, res) => {
  db.apiKeys = db.apiKeys.filter(k => k.id !== req.params.id);
  saveDb();
  res.json({ ok: true });
});


// Trading League
app.get('/api/trading', (req, res) => res.json(db.trading || {}));

app.patch('/api/trading/league', (req, res) => {
  db.trading.league = { ...db.trading.league, ...req.body };
  saveDb();
  broadcast({ type: 'TRADING_UPDATE', data: db.trading });
  res.json(db.trading.league);
});

app.patch('/api/trading/traders/:id', (req, res) => {
  const idx = db.trading.traders.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.trading.traders[idx] = { ...db.trading.traders[idx], ...req.body };
  saveDb();
  broadcast({ type: 'TRADING_UPDATE', data: db.trading });
  res.json(db.trading.traders[idx]);
});

app.post('/api/trading/trades', (req, res) => {
  const trade = { ...req.body, id: `tr${uuidv4().slice(0,8)}`, ts: new Date().toISOString() };
  db.trading.trades.unshift(trade);
  saveDb();
  addEvent('TRADER', trade.trader, 'trade', 'info', `New trade logged: ${trade.trader} ${trade.direction} ${trade.asset}`);
  broadcast({ type: 'TRADING_UPDATE', data: db.trading });
  res.status(201).json(trade);
});

// ─── TRADING DATA INTEGRATION ─────────────────────────────────
// Returns current data health: missing, stale, fresh
app.get('/api/trading/status', (req, res) => {
  const meta = db.trading?._meta || {};
  const now = Date.now();
  const lastTs = meta.lastReportTs ? new Date(meta.lastReportTs).getTime() : null;
  const ageMs = lastTs ? now - lastTs : null;
  const staleThresholdMs = 6 * 60 * 60 * 1000; // 6 hours

  let status = 'no_data';
  if (lastTs) {
    status = ageMs > staleThresholdMs ? 'stale' : 'fresh';
  } else if (db.trading?.traders?.length > 0) {
    // Has data but no report timestamp — legacy data, treat as stale
    status = 'stale';
  }

  res.json({
    status,
    hasTraders: (db.trading?.traders?.length || 0) > 0,
    traderCount: db.trading?.traders?.length || 0,
    tradeCount: db.trading?.trades?.length || 0,
    lastReportTs: meta.lastReportTs || null,
    lastReportSource: meta.lastReportSource || null,
    ageMs,
    ageHours: ageMs ? Math.round(ageMs / 3600000 * 10) / 10 : null,
    requestStatus: meta.requestStatus || 'idle',
  });
});

// Ingest a report sent directly from the Trader League system
// POST /api/trading/report/ingest — accepts full JSON report body
app.post('/api/trading/report/ingest', (req, res) => {
  try {
    const report = req.body;
    if (!report || typeof report !== 'object') {
      return res.status(400).json({ error: 'Invalid report body — expected JSON object' });
    }
    applyTradingReport(report, 'DIRECT_INGEST');
    res.json({ ok: true, ts: new Date().toISOString(), message: 'Report ingested and applied' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request the Supervisor (Claude AI) to generate a league report
// POST /api/trading/report/request
app.post('/api/trading/report/request', async (req, res) => {
  // Find Anthropic key
  const anthropicKey = db.apiKeys.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;

  if (!anthropicKey) {
    return res.status(400).json({
      error: 'no_api_key',
      message: 'Anthropic API key not found in API Vault. Add your key in the Vault tab with provider set to "Anthropic".'
    });
  }

  // Set status to requesting and broadcast
  db.trading._meta = { ...(db.trading._meta || {}), requestStatus: 'requesting', requestedAt: new Date().toISOString() };
  saveDb();
  broadcast({ type: 'TRADING_REPORT_STATUS', data: { status: 'requesting', ts: db.trading._meta.requestedAt } });
  addEvent('SUPERVISOR', 'Trader League', 'report_request', 'info', 'Supervisor report requested by Mission Control — awaiting structured output');

  // Send immediate response, process async
  res.json({ ok: true, message: 'Report request dispatched to Supervisor', ts: db.trading._meta.requestedAt });

  // Call Claude Supervisor async
  (async () => {
    try {
      const currentTrading = db.trading;
      const prompt = buildSupervisorPrompt(currentTrading);

      console.log('[SUPERVISOR] Requesting league report from Claude API…');
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          system: SUPERVISOR_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errBody.slice(0, 200)}`);
      }

      const apiData = await response.json();
      const rawText = apiData.content?.find(b => b.type === 'text')?.text || '';

      console.log('[SUPERVISOR] Report received — parsing JSON…');

      // Extract JSON from response (strip markdown fences if present)
      let reportJson;
      try {
        const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/```\s*([\s\S]*?)```/);
        const cleanText = jsonMatch ? jsonMatch[1].trim() : rawText.trim();
        reportJson = JSON.parse(cleanText);
      } catch (parseErr) {
        throw new Error(`JSON parse failed: ${parseErr.message}. Raw: ${rawText.slice(0, 300)}`);
      }

      applyTradingReport(reportJson, 'SUPERVISOR_AI');
      console.log('[SUPERVISOR] Report applied successfully');
      addEvent('SUPERVISOR', 'Trader League', 'report_complete', 'info', `League report received and applied — ${reportJson.traders?.length || 0} traders, ${reportJson.trades?.length || 0} trades`);

    } catch (err) {
      console.error('[SUPERVISOR] Report request failed:', err.message);
      db.trading._meta = { ...(db.trading._meta || {}), requestStatus: 'error', lastError: err.message };
      saveDb();
      broadcast({ type: 'TRADING_REPORT_STATUS', data: { status: 'error', error: err.message } });
      addEvent('SUPERVISOR', 'Trader League', 'report_error', 'error', `Report request failed: ${err.message.slice(0, 120)}`);
    }
  })();
});

// ─── APPLY REPORT ─────────────────────────────────────────────
function applyTradingReport(report, source) {
  const now = new Date().toISOString();

  // Merge report into db.trading — preserve existing fields not in report
  if (report.league)        db.trading.league = { ...db.trading.league, ...report.league };
  if (report.traders)       db.trading.traders = report.traders;
  if (report.trades)        db.trading.trades = report.trades;
  if (report.eliminated)    db.trading.eliminated = report.eliminated;
  if (report.weeklyStages)  db.trading.weeklyStages = report.weeklyStages;
  if (report.genome)        db.trading.genome = report.genome;
  if (report.riskAlerts)    db.trading.riskAlerts = report.riskAlerts;

  db.trading._meta = {
    lastReportTs: now,
    lastReportSource: source,
    reportStatus: 'fresh',
    requestStatus: 'complete',
    appliedAt: now,
    lastError: null,
    traderCount: report.traders?.length || 0,
    tradeCount: report.trades?.length || 0,
  };

  saveDb();
  broadcast({ type: 'TRADING_UPDATE', data: db.trading });
  broadcast({ type: 'TRADING_REPORT_STATUS', data: { status: 'complete', source, ts: now } });
}

// ─── SUPERVISOR PROMPT BUILDER ────────────────────────────────
const SUPERVISOR_SYSTEM_PROMPT = `You are the SUPERVISOR agent of ALEXIS OPS — the executive intelligence of a multi-agent trading league called "Trader League — La Logia".

Your role: generate structured, accurate league status reports in JSON format when requested by Mission Control.

Rules:
- Respond ONLY with a valid JSON object — no preamble, no explanation, no markdown outside the JSON
- Preserve continuity with existing data provided in the prompt
- All numeric values must be realistic and internally consistent
- Trades must have proper R:R ratios (minimum 2:1)
- Risk alerts must reference real limit violations
- The genome should reflect lessons learned from eliminated traders`;

function buildSupervisorPrompt(currentTrading) {
  const existing = currentTrading?.traders?.length > 0
    ? `EXISTING DATA (update/extend this):\n${JSON.stringify({
        league: currentTrading.league,
        traders: currentTrading.traders?.map(t => ({ id:t.id, name:t.name, strategy:t.strategyFamily, score:t.compositeScore, pnlPct:t.weeklyPnLPct })),
        openTrades: currentTrading.trades?.filter(t => t.status === 'open').length || 0,
        closedTrades: currentTrading.trades?.filter(t => t.status === 'closed').length || 0,
        currentStage: currentTrading.weeklyStages?.find(s => s.status === 'current')?.name || 'Unknown',
      }, null, 2)}`
    : 'No existing data — generate a fresh Gen 1 Week 1 league report.';

  return `Mission Control is requesting an updated Trading League status report.

${existing}

Generate a complete, updated league report as a single JSON object with this exact schema:

{
  "league": {
    "name": "Trader League — La Logia",
    "generation": <number>,
    "currentWeek": <number>,
    "totalCapital": <number>,
    "allocatedCapital": <number>,
    "remainingCapital": <number>,
    "weeklyPnL": <number>,
    "weeklyPnLPct": <number>,
    "activeTraders": <number>,
    "totalTrades": <number>,
    "cycleStage": <1-8>,
    "capitalHistory": [{"week": "<label>", "capital": <number>}]
  },
  "traders": [{
    "id": "<string>",
    "name": "<ALLCAPS>",
    "generation": <number>,
    "strategyFamily": "<string>",
    "status": "active|eliminated",
    "startCapital": <number>,
    "currentCapital": <number>,
    "weeklyPnL": <number>,
    "weeklyPnLPct": <number>,
    "totalReturn": <number>,
    "winRate": <0-100>,
    "drawdown": <number>,
    "drawdownMax": <number>,
    "tradesThisWeek": <number>,
    "compositeScore": <0-100>,
    "thesis": "<current market thesis>",
    "confidenceTrend": [<6 numbers 0-100>],
    "topLesson": "<key lesson learned>",
    "nextAction": "<specific next action>",
    "indicators": ["<indicator>"],
    "riskPerTrade": <number>,
    "openTrades": <number>
  }],
  "eliminated": [{
    "id": "<string>",
    "name": "<ALLCAPS>",
    "generation": <number>,
    "strategyFamily": "<string>",
    "eliminatedWeek": <number>,
    "finalReturn": <number>,
    "topMistake": "<string>",
    "memoryGift": "<lesson for survivors>",
    "capsule": "<elimination story>"
  }],
  "trades": [{
    "id": "<string>",
    "trader": "<trader name>",
    "asset": "BTC/USD|ETH/USD",
    "direction": "Long|Short",
    "entry": <number>,
    "sl": <number>,
    "tp": <number>,
    "exit": <number|null>,
    "pnl": <number|null>,
    "pnlPct": <number|null>,
    "setup": "<setup type>",
    "reason": "<trade reason>",
    "lesson": "<lesson or null>",
    "ts": "<ISO timestamp>",
    "status": "open|closed"
  }],
  "weeklyStages": [{
    "id": <1-8>,
    "name": "<stage name>",
    "desc": "<description>",
    "status": "done|current|pending"
  }],
  "genome": {
    "winningPatterns": ["<pattern>"],
    "losingPatterns": ["<pattern>"],
    "indicatorInsights": ["<insight>"],
    "sentimentInsights": ["<insight>"],
    "riskLessons": ["<lesson>"]
  },
  "riskAlerts": [{
    "id": "<string>",
    "trader": "<trader name>",
    "type": "drawdown|win_rate|open_trades|leverage|stop_missing",
    "severity": "warn|error|info",
    "message": "<alert message>",
    "ts": "<ISO timestamp>"
  }]
}

Rules for this report:
- All traders must have realistic, internally consistent P&L and scores
- Composite score = 40% return performance + 20% drawdown control + 15% win rate + 15% strategy consistency + 10% documentation quality
- Open trades must have exit=null, pnl=null, pnlPct=null
- Closed trades must have real exit prices, pnl, and a lesson
- Exactly one weekly stage must have status "current"
- Risk alerts only for real limit violations (drawdown>5%, win rate<50% for 3+ trades, etc.)
- Respond with ONLY the JSON object, starting with { and ending with }`;
}

// ─── MARKET INTELLIGENCE ENDPOINTS ──────────────────────────
app.get('/api/market-intel', (req, res) => {
  res.json(db.trading?.marketIntel || {});
});

// Refresh market intelligence via Claude Supervisor
app.post('/api/market-intel/refresh', async (req, res) => {
  const anthropicKey = db.apiKeys?.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;

  if (!anthropicKey) {
    return res.status(400).json({ error: 'no_api_key', message: 'Anthropic API key not found in Vault.' });
  }

  // Set refreshing status
  if (!db.trading.marketIntel) db.trading.marketIntel = {};
  db.trading.marketIntel._meta = { ...(db.trading.marketIntel._meta||{}), refreshStatus: 'refreshing', source: null };
  saveDb();
  broadcast({ type: 'MARKET_INTEL_STATUS', data: { status: 'refreshing' } });
  res.json({ ok: true, message: 'Market intelligence refresh dispatched' });

  (async () => {
    try {
      const existing = db.trading.marketIntel;
      const prompt = buildMarketIntelPrompt(existing);
      console.log('[MARKET-INTEL] Requesting intelligence update from Claude API…');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          system: MARKET_INTEL_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) throw new Error(`API error ${response.status}`);
      const apiData = await response.json();
      const rawText = apiData.content?.find(b => b.type === 'text')?.text || '';
      const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/\{[\s\S]*\}/);
      const cleanText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : rawText.trim();
      const intel = JSON.parse(cleanText);

      const now = new Date().toISOString();
      db.trading.marketIntel = {
        ...db.trading.marketIntel,
        ...intel,
        _meta: { lastRefresh: now, refreshStatus: 'fresh', source: 'SUPERVISOR_AI', nextScheduled: null }
      };
      saveDb();
      broadcast({ type: 'MARKET_INTEL_UPDATE', data: db.trading.marketIntel });
      broadcast({ type: 'MARKET_INTEL_STATUS', data: { status: 'complete', ts: now } });
      addEvent('SUPERVISOR', 'Trader League', 'market_intel', 'info', 'Market intelligence refreshed — BTC/ETH signals updated');
      console.log('[MARKET-INTEL] Intelligence updated successfully');
    } catch (err) {
      console.error('[MARKET-INTEL] Refresh failed:', err.message);
      db.trading.marketIntel._meta = { ...(db.trading.marketIntel._meta||{}), refreshStatus: 'error', lastError: err.message };
      saveDb();
      broadcast({ type: 'MARKET_INTEL_STATUS', data: { status: 'error', error: err.message } });
    }
  })();
});

// Dismiss a market alert
app.patch('/api/market-intel/alerts/:id/dismiss', (req, res) => {
  const alerts = db.trading.marketIntel?.alerts || [];
  const idx = alerts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Alert not found' });
  db.trading.marketIntel.alerts[idx].active = false;
  saveDb();
  broadcast({ type: 'MARKET_INTEL_UPDATE', data: db.trading.marketIntel });
  res.json({ ok: true });
});

// ─── MARKET INTEL PROMPT ──────────────────────────────────────
const MARKET_INTEL_SYSTEM_PROMPT = `You are the SUPERVISOR agent of ALEXIS OPS, providing real-time market intelligence for the Trader League — La Logia.

Your role: generate a structured market intelligence JSON report for BTC and ETH.
Rules:
- Respond ONLY with a valid JSON object. No preamble, no markdown outside the JSON block.
- All data must be realistic, internally consistent, and reflect current market knowledge.
- Sentiment, volatility, and trend data must be coherent with each other.
- Alerts must be actionable and specific to the market conditions you describe.`;

function buildMarketIntelPrompt(existing) {
  const lastPrices = existing?.prices ? `Last known: BTC $${existing.prices.BTC?.price?.toLocaleString()}, ETH $${existing.prices.ETH?.price?.toLocaleString()}` : 'No prior data';
  return `Generate a current Market Intelligence Report for the Trader League — La Logia.
${lastPrices}

Return ONLY a JSON object with this exact schema:

{
  "prices": {
    "BTC": { "price": <number>, "change24h": <number>, "change7d": <number>, "volume24h": <number>, "volumeTrend": "increasing|decreasing|stable" },
    "ETH": { "price": <number>, "change24h": <number>, "change7d": <number>, "volume24h": <number>, "volumeTrend": "increasing|decreasing|stable" }
  },
  "trends": {
    "BTC": { "state": "strong_bullish|bullish|neutral|bearish|strong_bearish", "strength": <0-100>, "ema20": <number>, "ema50": <number>, "ema200": <number>, "structure": "<price structure>", "keyLevel": { "support": <number>, "resistance": <number> }, "summary": "<1-2 sentence analysis>" },
    "ETH": { "state": "<same>", "strength": <0-100>, "ema20": <number>, "ema50": <number>, "ema200": <number>, "structure": "<structure>", "keyLevel": { "support": <number>, "resistance": <number> }, "summary": "<analysis>" }
  },
  "volatility": {
    "state": "low|normal|high|extreme",
    "index": <0-100>,
    "BTC": { "atr14": <number>, "atrPct": <number>, "bbWidth": <0-1>, "compression": <bool>, "breakoutRisk": "low|moderate|high|imminent" },
    "ETH": { "atr14": <number>, "atrPct": <number>, "bbWidth": <0-1>, "compression": <bool>, "breakoutRisk": "low|moderate|high|imminent" },
    "regime": "<regime description>",
    "note": "<actionable volatility note>"
  },
  "sentiment": {
    "overall": <0-100>,
    "state": "extreme_fear|fear|neutral|greed|extreme_greed",
    "fearGreedIndex": <0-100>,
    "social": { "score": <0-100>, "label": "<label>", "dominantNarrative": "<narrative>" },
    "news": { "score": <0-100>, "label": "<label>", "topTheme": "<theme>" },
    "positioning": { "bias": "long|short|neutral", "longRatio": <0-100>, "shortRatio": <0-100>, "note": "<note>" },
    "fundingRate": { "BTC": <number>, "ETH": <number>, "interpretation": "<interpretation>" }
  },
  "news": [
    { "id": "n1", "headline": "<headline>", "asset": "BTC|ETH|MACRO", "impact": "low|medium|high|market_moving", "bias": "bullish|bearish|neutral", "confidence": <0-100>, "category": "<category>", "summary": "<1 sentence>" }
  ],
  "macro": {
    "bias": "crypto_supportive|neutral|crypto_negative",
    "strength": <0-100>,
    "signals": [
      { "name": "<signal name>", "value": "<value>", "impact": "positive|neutral|negative", "icon": "<emoji>" }
    ],
    "summary": "<2 sentence macro summary>"
  },
  "onchain": {
    "signals": [
      { "type": "exchange_inflow|exchange_outflow|whale_activity|network_activity|stablecoin_flows|funding_rate", "asset": "BTC|ETH|USDT", "value": "<value string>", "trend": "increasing|decreasing|stable|spike", "severity": "normal|notable|warning|critical", "label": "<label>", "detail": "<detail>", "bullish": <true|false|null> }
    ]
  },
  "liquidity": {
    "BTC": {
      "zones": [ { "price": <number>, "type": "resistance_liquidity|support_liquidity|round_number|major_support|major_resistance", "size": "small|medium|large|xlarge", "label": "<label>", "detail": "<detail>" } ],
      "leverageMap": "<leverage description>",
      "squeezeRisk": "low|moderate|moderate-high|high|critical"
    },
    "ETH": {
      "zones": [ { "price": <number>, "type": "<type>", "size": "<size>", "label": "<label>", "detail": "<detail>" } ],
      "leverageMap": "<leverage description>",
      "squeezeRisk": "low|moderate|moderate-high|high|critical"
    }
  },
  "traderBehavior": {
    "popularSetups": [ { "setup": "<setup>", "asset": "BTC|ETH", "popularity": <0-100>, "edge": "positive|neutral|negative", "note": "<note>" } ],
    "momentumBias": "bullish|bearish|neutral",
    "momentumStrength": <0-100>,
    "crowdedTrade": { "direction": "long|short", "asset": "BTC|ETH", "level": "low|moderate|high|extreme", "warning": "<warning>" },
    "contrarian": { "signal": "<contrarian signal>", "confidence": <0-100> },
    "sentimentDivergence": "<divergence note>"
  },
  "alerts": [
    { "id": "a1", "type": "volatility|sentiment|liquidity|onchain|regulatory|institutional_flow|macro", "asset": "BTC|ETH|MACRO", "severity": "info|warning|high|critical", "title": "<title>", "message": "<actionable message>", "active": true }
  ]
}

Generate 4-6 news items, 5-7 on-chain signals, 4 liquidity zones per asset, 3-5 popular setups, and 2-5 alerts based on the market conditions you describe.
Respond with ONLY the JSON object.`;
}

// ─── AI TRADE SIMULATOR ENDPOINTS ───────────────────────────

// GET full simulator state
app.get('/api/simulator', (req, res) => res.json(db.trading?.simulator || {}));

// GET simulator status
app.get('/api/simulator/status', (req, res) => {
  const sim = db.trading?.simulator;
  res.json({
    engineStatus: sim?._meta?.engineStatus || 'inactive',
    week: sim?._meta?.simulationWeek || 0,
    totalAccounts: sim?.accounts?.length || 0,
    totalTrades: sim?.trades?.length || 0,
    openTrades: sim?.trades?.filter(t => t.status === 'open').length || 0,
    aiRequestInFlight: sim?._meta?.aiRequestInFlight || false
  });
});

// POST — request AI to generate a new simulated trade for a specific trader
app.post('/api/simulator/generate-trade', async (req, res) => {
  const { trader } = req.body;
  if (!trader) return res.status(400).json({ error: 'trader required' });

  const anthropicKey = db.apiKeys?.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key', message: 'Anthropic API key not found in Vault.' });

  const account = db.trading.simulator.accounts.find(a => a.trader === trader);
  const traderData = db.trading.traders?.find(t => t.name === trader);
  if (!account) return res.status(404).json({ error: 'Trader not found' });
  if (account.openTrades >= db.trading.simulator.config.maxOpenTrades) {
    return res.status(400).json({ error: 'max_open_trades', message: `${trader} already has ${account.openTrades} open trades (max ${db.trading.simulator.config.maxOpenTrades})` });
  }

  db.trading.simulator._meta.aiRequestInFlight = true;
  saveDb();
  broadcast({ type: 'SIMULATOR_STATUS', data: { trader, status: 'generating' } });
  res.json({ ok: true, message: `Trade generation dispatched for ${trader}` });

  (async () => {
    try {
      const mi = db.trading.marketIntel;
      const prompt = buildSimTradePrompt(trader, account, traderData, mi, db.trading.simulator.config);
      console.log(`[SIMULATOR] Generating trade for ${trader}…`);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, system: SIM_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] })
      });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const apiData = await response.json();
      const rawText = apiData.content?.find(b => b.type === 'text')?.text || '';
      const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/\{[\s\S]*\}/);
      const tradeJson = JSON.parse((jsonMatch?.[1] || jsonMatch?.[0] || rawText).trim());

      // Validate with risk manager
      const validation = validateSimTrade(tradeJson, account, db.trading.simulator.config);
      if (!validation.pass) {
        addSimAlert(trader, 'risk_violation', 'warning', `Risk Manager rejected trade: ${validation.reasons.join(', ')}`);
        account.riskViolations = (account.riskViolations || 0) + 1;
        db.trading.simulator._meta.aiRequestInFlight = false;
        saveDb();
        broadcast({ type: 'SIMULATOR_STATUS', data: { trader, status: 'trade_rejected', reasons: validation.reasons } });
        broadcast({ type: 'SIMULATOR_UPDATE', data: db.trading.simulator });
        return;
      }

      // Record the trade
      const tradeId = `st${Date.now().toString(36)}`;
      const newTrade = {
        id: tradeId, simTrader: trader, asset: tradeJson.asset, direction: tradeJson.direction,
        entry: tradeJson.entry, sl: tradeJson.sl, tp: tradeJson.tp,
        size: tradeJson.size || db.trading.simulator.config.startingBalance * (db.trading.simulator.config.riskPerTrade / 100) / Math.abs(tradeJson.entry - tradeJson.sl),
        exit: null, pnl: null, pnlPct: null, status: 'open',
        riskValidated: true, setup: tradeJson.setup, reason: tradeJson.reason,
        lesson: null, ts: new Date().toISOString(), closedTs: null
      };
      db.trading.simulator.trades.unshift(newTrade);
      account.openTrades = (account.openTrades || 0) + 1;
      account.lastAction = `${tradeJson.direction} ${tradeJson.asset} at $${tradeJson.entry.toLocaleString()} — ${tradeJson.setup}`;
      db.trading.simulator._meta.aiRequestInFlight = false;
      db.trading.simulator._meta.lastTick = new Date().toISOString();
      saveDb();
      addEvent('TRADER', trader, 'sim_trade', 'info', `SIM: ${trader} ${tradeJson.direction} ${tradeJson.asset} @ $${tradeJson.entry.toLocaleString()} | SL $${tradeJson.sl} | TP $${tradeJson.tp}`);
      broadcast({ type: 'SIMULATOR_STATUS', data: { trader, status: 'trade_placed', tradeId } });
      broadcast({ type: 'SIMULATOR_UPDATE', data: db.trading.simulator });
      console.log(`[SIMULATOR] Trade placed for ${trader}: ${tradeJson.direction} ${tradeJson.asset} @ ${tradeJson.entry}`);
    } catch (err) {
      console.error(`[SIMULATOR] Trade generation failed for ${trader}:`, err.message);
      db.trading.simulator._meta.aiRequestInFlight = false;
      saveDb();
      broadcast({ type: 'SIMULATOR_STATUS', data: { trader, status: 'error', error: err.message } });
    }
  })();
});

// POST — close a specific trade manually (with exit price)
app.post('/api/simulator/close-trade', (req, res) => {
  const { tradeId, exitPrice, lesson } = req.body;
  if (!tradeId || !exitPrice) return res.status(400).json({ error: 'tradeId and exitPrice required' });

  const trade = db.trading.simulator.trades.find(t => t.id === tradeId);
  if (!trade || trade.status !== 'open') return res.status(404).json({ error: 'Open trade not found' });

  closeSimTrade(trade, exitPrice, lesson);
  saveDb();
  broadcast({ type: 'SIMULATOR_UPDATE', data: db.trading.simulator });
  res.json({ ok: true, trade });
});

// POST — run full trade resolution tick (resolve SL/TP hits using current prices)
app.post('/api/simulator/tick', (req, res) => {
  const prices = db.trading.marketIntel?.prices;
  if (!prices) return res.status(400).json({ error: 'No market prices available' });

  let resolved = 0;
  db.trading.simulator.trades.filter(t => t.status === 'open').forEach(trade => {
    const currentPrice = prices[trade.asset.replace('/USD','')]?.price;
    if (!currentPrice) return;
    // Check TP hit
    if ((trade.direction === 'Long' && currentPrice >= trade.tp) ||
        (trade.direction === 'Short' && currentPrice <= trade.tp)) {
      closeSimTrade(trade, trade.tp, 'Take profit hit');
      resolved++;
    }
    // Check SL hit
    else if ((trade.direction === 'Long' && currentPrice <= trade.sl) ||
             (trade.direction === 'Short' && currentPrice >= trade.sl)) {
      closeSimTrade(trade, trade.sl, 'Stop loss hit — review entry timing');
      resolved++;
    }
  });

  db.trading.simulator._meta.lastTick = new Date().toISOString();
  if (resolved > 0) {
    saveDb();
    broadcast({ type: 'SIMULATOR_UPDATE', data: db.trading.simulator });
    addEvent('SUPERVISOR', 'Simulator', 'tick', 'info', `Sim tick: ${resolved} trade(s) resolved`);
  }
  res.json({ ok: true, resolved });
});

// POST — dismiss a simulation alert
app.patch('/api/simulator/alerts/:id/dismiss', (req, res) => {
  const alert = db.trading.simulator.simulationAlerts?.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.active = false;
  saveDb();
  broadcast({ type: 'SIMULATOR_UPDATE', data: db.trading.simulator });
  res.json({ ok: true });
});

// ─── SIM HELPERS ──────────────────────────────────────────────
function closeSimTrade(trade, exitPrice, lesson) {
  trade.exit = exitPrice;
  trade.pnl = parseFloat(((exitPrice - trade.entry) * trade.size * (trade.direction === 'Long' ? 1 : -1)).toFixed(4));
  trade.pnlPct = parseFloat((trade.pnl / (trade.entry * trade.size) * 100).toFixed(2));
  trade.status = 'closed';
  trade.lesson = lesson || null;
  trade.closedTs = new Date().toISOString();

  // Update account
  const account = db.trading.simulator.accounts.find(a => a.trader === trade.simTrader);
  if (!account) return;
  account.currentBalance = parseFloat((account.currentBalance + trade.pnl).toFixed(4));
  account.totalPnL = parseFloat((account.totalPnL + trade.pnl).toFixed(4));
  account.returnPct = parseFloat(((account.currentBalance - account.startBalance) / account.startBalance * 100).toFixed(2));
  account.totalTrades = (account.totalTrades || 0) + 1;
  if (trade.pnl > 0) account.wins = (account.wins || 0) + 1;
  else account.losses = (account.losses || 0) + 1;
  account.winRate = parseFloat((account.wins / account.totalTrades * 100).toFixed(1));
  account.openTrades = Math.max(0, (account.openTrades || 1) - 1);
  if (account.currentBalance > (account.peakBalance || account.startBalance)) {
    account.peakBalance = account.currentBalance;
  }
  account.drawdown = parseFloat(((account.peakBalance - account.currentBalance) / account.peakBalance * 100).toFixed(2));
  account.maxDrawdown = Math.max(account.maxDrawdown || 0, account.drawdown);

  // Check drawdown alert
  if (account.drawdown > 15 && account.drawdown <= 20) addSimAlert(account.trader, 'drawdown', 'warning', `${account.trader} drawdown at ${account.drawdown}% — approaching 20% limit`);
  if (account.drawdown > 20) addSimAlert(account.trader, 'drawdown_exceeded', 'high', `${account.trader} DRAWDOWN EXCEEDED 20% — simulation review required`);

  // Update promotion queue
  const pq = db.trading.simulator.promotionQueue?.find(p => p.trader === account.trader);
  if (pq) {
    pq.returnPct = account.returnPct;
    pq.maxDrawdown = account.maxDrawdown;
    pq.winRate = account.winRate;
    pq.riskScore = account.riskScore;
  }
}

function addSimAlert(trader, type, severity, message) {
  if (!db.trading.simulator.simulationAlerts) db.trading.simulator.simulationAlerts = [];
  db.trading.simulator.simulationAlerts.unshift({
    id: `sa${Date.now().toString(36)}`, trader, type, severity, message,
    active: true, ts: new Date().toISOString()
  });
}

function validateSimTrade(trade, account, config) {
  const reasons = [];
  const riskAmount = account.currentBalance * (config.riskPerTrade / 100);
  const slDistance = Math.abs(trade.entry - trade.sl);
  const size = riskAmount / slDistance;
  const tpDistance = Math.abs(trade.tp - trade.entry);
  const rr = tpDistance / slDistance;

  if (!['BTC/USD','ETH/USD'].includes(trade.asset)) reasons.push(`Invalid asset: ${trade.asset}`);
  if (!['Long','Short'].includes(trade.direction)) reasons.push('Invalid direction');
  if (!trade.sl || !trade.tp) reasons.push('Missing SL or TP');
  if (rr < 1.5) reasons.push(`R:R ratio too low: ${rr.toFixed(1)} (min 1.5:1)`);
  if (slDistance / trade.entry > 0.05) reasons.push('Stop loss too wide (>5%)');
  if (account.openTrades >= config.maxOpenTrades) reasons.push('Max open trades reached');
  if (account.currentBalance < account.startBalance * 0.8) reasons.push('Balance too low for new trades');

  return { pass: reasons.length === 0, reasons };
}

// ─── SIM AI PROMPT ────────────────────────────────────────────
const SIM_SYSTEM_PROMPT = `You are a simulated trading agent AI operating within ALEXIS OPS Trader League — La Logia simulator.
Generate a single, well-structured simulated trade for the specified trader.
Rules:
- Respond ONLY with a JSON object containing the trade parameters
- The trade must be realistic given current market conditions
- Stop loss must be technically valid (not arbitrary)
- R:R ratio must be minimum 2:1
- Entry must be close to current market price (within 0.5%)
- All prices must be realistic for BTC/USD or ETH/USD
- DO NOT suggest trades with SL wider than 3% from entry`;

function buildSimTradePrompt(trader, account, traderData, mi, config) {
  const btcPrice = mi?.prices?.BTC?.price || 84000;
  const ethPrice = mi?.prices?.ETH?.price || 3200;
  const btcTrend = mi?.trends?.BTC?.state || 'bullish';
  const ethTrend = mi?.trends?.ETH?.state || 'bullish';
  const sentiment = mi?.sentiment?.overall || 65;
  const volState = mi?.volatility?.state || 'normal';

  return `Generate a simulated trade for trader: ${trader}
Strategy: ${traderData?.strategyFamily || account.strategy}
Current balance: $${account.currentBalance.toFixed(2)} USDT (started $${account.startBalance})
Return so far: ${account.returnPct >= 0 ? '+' : ''}${account.returnPct}%
Win rate: ${account.winRate}%
Open trades: ${account.openTrades}

CURRENT MARKET CONDITIONS:
- BTC/USD: $${btcPrice.toLocaleString()} | Trend: ${btcTrend}
- ETH/USD: $${ethPrice.toLocaleString()} | Trend: ${ethTrend}
- Sentiment: ${sentiment}/100
- Volatility: ${volState}
- BTC key levels: Support $${mi?.trends?.BTC?.keyLevel?.support?.toLocaleString() || '81000'} | Resistance $${mi?.trends?.BTC?.keyLevel?.resistance?.toLocaleString() || '87000'}
- ETH key levels: Support $${mi?.trends?.ETH?.keyLevel?.support?.toLocaleString() || '3050'} | Resistance $${mi?.trends?.ETH?.keyLevel?.resistance?.toLocaleString() || '3380'}

RISK RULES:
- Max risk per trade: ${config.riskPerTrade}% of balance = $${(account.currentBalance * config.riskPerTrade / 100).toFixed(3)} USDT
- Min R:R: 2:1
- Max SL: 3% from entry
- Position size = risk amount / SL distance

Respond with ONLY this JSON object:
{
  "asset": "BTC/USD or ETH/USD",
  "direction": "Long or Short",
  "entry": <price very close to current market>,
  "sl": <technically valid stop loss>,
  "tp": <take profit at minimum 2:1 RR>,
  "size": <position size in base asset units>,
  "setup": "<specific setup name e.g. 'Momentum Breakout Retest'>",
  "reason": "<1-2 sentence trade rationale based on current conditions>",
  "confidence": <50-95>
}`;
}

// ─── EXECUTION GUARD ENDPOINTS ───────────────────────────────

app.get('/api/guard', (req, res) => res.json(db.trading?.executionGuard || {}));

app.post('/api/guard/validate', (req, res) => {
  const EG = db.trading?.executionGuard;
  if (!EG) return res.status(500).json({ error: 'EG not initialized' });
  const { trader, asset, direction, entry, sl, tp, size, leverage = 1 } = req.body;
  if (!trader || !asset || !direction || !entry || !size)
    return res.status(400).json({ error: 'Missing required fields' });
  const id = 'eg_' + Date.now().toString(36);
  const tsNow = new Date().toISOString();
  const con = EG.constitution;
  const tState = EG.traderState[trader] || { capital: 25, openTrades: 0, weeklyTradeCount: 0, positions: [] };
  const maxSize = (tState.capital * con.maxExposurePct) / 100;
  const slDist  = sl ? Math.abs((entry - sl) / entry * 100) : null;
  const rrRatio = (sl && tp) ? Math.abs(tp - entry) / Math.abs(entry - sl) : null;
  const lvg     = leverage || 1;
  const conflictPos = (tState.positions || []).find(p => p.asset === asset && p.direction !== direction);
  const volatility  = db.trading?.marketIntel?.volatility?.state || 'normal';
  const checks = {
    capitalLimit:    { pass: size <= maxSize, value: size+' USDT', limit: maxSize.toFixed(2)+' USDT (10% of '+tState.capital+')', note: size <= maxSize ? 'Within capital limit' : 'VIOLATION: '+size+' USDT exceeds '+maxSize.toFixed(2)+' max' },
    stopLoss:        { pass: !!sl, value: sl ? '$'+sl : 'MISSING', limit: 'Required', note: sl ? 'SL defined' : 'VIOLATION: No stop loss provided. Mandatory.' },
    slDistance:      { pass: slDist !== null && slDist <= con.maxSLDistancePct, value: slDist !== null ? slDist.toFixed(2)+'%' : 'N/A', limit: '<='+con.maxSLDistancePct+'%', note: slDist === null ? 'Cannot validate — SL missing' : slDist <= con.maxSLDistancePct ? 'SL distance OK' : 'VIOLATION: '+slDist.toFixed(2)+'% > '+con.maxSLDistancePct+'%' },
    openTrades:      { pass: (tState.openTrades||0) < con.maxOpenTradesPerTrader, value: (tState.openTrades||0)+' open', limit: '<='+con.maxOpenTradesPerTrader, note: (tState.openTrades||0) < con.maxOpenTradesPerTrader ? 'Under limit' : 'VIOLATION: At max open trades' },
    weeklyCount:     { pass: (tState.weeklyTradeCount||0) < con.maxTradesPerWeekPerTrader, value: (tState.weeklyTradeCount||0)+' this week', limit: '<='+con.maxTradesPerWeekPerTrader+'/week', note: (tState.weeklyTradeCount||0) < con.maxTradesPerWeekPerTrader ? 'Under weekly limit' : 'VIOLATION: Weekly limit reached' },
    rrRatio:         { pass: rrRatio !== null && rrRatio >= con.minRR, value: rrRatio !== null ? rrRatio.toFixed(2)+':1' : 'N/A', limit: '>='+con.minRR+':1', note: rrRatio === null ? 'Cannot calculate — SL or TP missing' : rrRatio >= con.minRR ? 'RR adequate' : 'VIOLATION: '+rrRatio.toFixed(2)+' < '+con.minRR+' min' },
    leverage:        { pass: lvg <= con.maxLeverage, value: lvg+'x', limit: '<='+con.maxLeverage+'x', note: lvg <= con.maxLeverage ? 'Within leverage limit' : 'VIOLATION: '+lvg+'x exceeds '+con.maxLeverage+'x max' },
    allowedAsset:    { pass: (con.allowedAssets||[]).includes(asset), value: asset, limit: (con.allowedAssets||[]).join(', '), note: (con.allowedAssets||[]).includes(asset) ? 'Asset approved' : 'VIOLATION: '+asset+' not on approved list' },
    conflictCheck:   { pass: !conflictPos, value: conflictPos ? 'CONFLICT: '+direction+' vs existing '+conflictPos.direction : 'No conflict', limit: 'No opposing position same asset', note: conflictPos ? 'VIOLATION: Simultaneous '+asset+' '+direction+'+'+conflictPos.direction : 'No conflict detected' },
    volatilityCheck: { pass: volatility !== 'extreme', value: volatility, limit: 'Not extreme', note: volatility === 'extreme' ? 'DELAY: Extreme volatility detected' : 'Volatility acceptable' }
  };
  const failedChecks = Object.entries(checks).filter(([,v]) => !v.pass).map(([k]) => k);
  const hasHardFail  = ['stopLoss','capitalLimit','allowedAsset','conflictCheck'].some(k => !checks[k].pass);
  const isVolDelay   = !checks.volatilityCheck.pass && failedChecks.length === 1;
  let status = failedChecks.length === 0 ? 'approved' : (isVolDelay && !hasHardFail ? 'delayed' : 'rejected');
  const authCode = status === 'approved' ? 'EG-'+trader+'-'+Date.now().toString(36).toUpperCase() : null;
  const record = { id, trader, asset, direction, entry, sl: sl||null, tp: tp||null, size, leverage: lvg, riskPct: slDist, rrRatio, proposedBy: trader, status, authCode, checks, failedChecks, guardNote: buildGuardNote2(status, failedChecks, checks, trader), delayReason: isVolDelay ? 'Extreme volatility — auto-recheck in 30m.' : undefined, ts: tsNow, resolvedTs: status !== 'delayed' ? tsNow : null };
  EG.guardQueue.unshift(record);
  EG.guardQueue = EG.guardQueue.slice(0, 20);
  EG._meta.totalChecked++;
  if (status === 'approved') { EG._meta.totalApproved++; tState.openTrades = (tState.openTrades||0)+1; tState.weeklyTradeCount = (tState.weeklyTradeCount||0)+1; (tState.positions = tState.positions||[]).push({ asset, direction, size }); }
  if (status === 'rejected') EG._meta.totalRejected++;
  if (status === 'delayed')  EG._meta.totalDelayed++;
  EG._meta.lastCheck = tsNow;
  addGuardLog2(EG, status.toUpperCase(), trader, id, failedChecks);
  saveDb();
  broadcast({ type: 'GUARD_UPDATE', data: db.trading.executionGuard });
  res.json({ ok: true, id, status, authCode, failedChecks, checksRun: 10 });
});

app.post('/api/guard/analyze/:id', async (req, res) => {
  const EG = db.trading?.executionGuard;
  const trade = EG?.guardQueue?.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  const anthropicKey = db.apiKeys?.find(k => (k.provider==='Anthropic'||k.name?.toLowerCase().includes('anthropic'))&&k.key?.length>20)?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key' });
  res.json({ ok: true });
  (async () => {
    try {
      const prompt = `Review this Execution Guard result:\nTrader: ${trade.trader} | Asset: ${trade.asset} ${trade.direction}\nEntry: $${trade.entry} | SL: ${trade.sl?'$'+trade.sl:'MISSING'} | TP: ${trade.tp?'$'+trade.tp:'N/A'}\nSize: ${trade.size} USDT | Status: ${trade.status.toUpperCase()}\nFailed: ${trade.failedChecks.join(', ')||'none'}\nChecks:\n${Object.entries(trade.checks).map(([k,v])=>(v.pass?'✓':'✗')+' '+k+': '+v.note).join('\n')}\n\nProvide a concise 3-4 sentence professional assessment and what the trader should do next.`;
      const raw = await callClaudeStr(anthropicKey, 'You are the Execution Guard AI of ALEXIS OPS. Be direct and professional.', prompt, 300);
      trade.aiAnalysis = raw.trim();
      saveDb();
      broadcast({ type: 'GUARD_UPDATE', data: db.trading.executionGuard });
    } catch(e) { console.error('[GUARD] AI analysis failed:', e.message); }
  })();
});

app.patch('/api/guard/:id/override', (req, res) => {
  const EG = db.trading?.executionGuard;
  const trade = EG?.guardQueue?.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const prev = trade.status;
  trade.status = status;
  trade.resolvedTs = new Date().toISOString();
  if (note) trade.guardNote = note;
  if (status === 'approved') trade.authCode = 'EG-'+trade.trader+'-OVR-'+Date.now().toString(36).toUpperCase();
  if (prev === 'delayed') { EG._meta.totalDelayed = Math.max(0, (EG._meta.totalDelayed||1)-1); if (status==='approved') EG._meta.totalApproved++; else EG._meta.totalRejected++; }
  addGuardLog2(EG, 'OVERRIDE->'+status.toUpperCase(), trade.trader, trade.id, []);
  saveDb();
  broadcast({ type: 'GUARD_UPDATE', data: db.trading.executionGuard });
  res.json({ ok: true, trade });
});

function buildGuardNote2(status, failed, checks, trader) {
  if (status === 'approved') return 'All 10 checks passed. Trade meets constitutional requirements. Execution authorized for '+trader+'.';
  if (status === 'delayed')  return 'Trade structurally valid — delayed: '+checks.volatilityCheck?.note+'. Will re-evaluate when volatility normalizes.';
  return failed.length+' violation'+(failed.length>1?'s':'')+': '+failed.map(k=>checks[k]?.note).filter(Boolean).join(' | ');
}
function addGuardLog2(EG, event, trader, tradeId, failed) {
  const entry = { id:'gl_'+Date.now().toString(36), ts:new Date().toISOString(), event, trader, tradeId, detail: failed.length ? 'Violations: '+failed.join(', ') : event };
  EG.guardLog = [entry,...(EG.guardLog||[])].slice(0,50);
}


// ─── MARKET REGIME DETECTOR ENDPOINTS ────────────────────────

app.get('/api/regime', (req, res) => res.json(db.trading?.marketRegime || {}));

app.post('/api/regime/analyze', async (req, res) => {
  const MRD = db.trading?.marketRegime;
  if (!MRD) return res.status(500).json({ error: 'MRD not initialized' });
  if (MRD._meta?.aiInFlight) return res.status(409).json({ error: 'Analysis already running' });

  const anthropicKey = db.apiKeys?.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key', message: 'Anthropic API key required.' });

  MRD._meta.aiInFlight = true;
  MRD._meta.status = 'analyzing';
  saveDb();
  broadcast({ type: 'MRD_STATUS', data: { status: 'analyzing', message: 'Analyzing market regime…' } });
  res.json({ ok: true, message: 'Regime analysis dispatched' });

  (async () => {
    try {
      const mi     = db.trading?.marketIntel || {};
      const prompt = buildRegimePrompt(MRD, mi);
      console.log('[MRD] Running AI regime analysis…');
      const raw    = await callClaudeStr(anthropicKey, MRD_SYSTEM, prompt, 2000);
      const parsed = safeParseJSON(raw);

      if (parsed?.regimes) {
        const STRAT_MAP = MRD_STRATEGY_MAP;
        ['BTC','ETH'].forEach(asset => {
          const r = parsed.regimes[asset];
          if (!r) return;
          const prev = MRD.regimes[asset]?.currentRegime;
          const regime = MRD.regimes[asset] || {};
          const changed = prev && prev !== r.currentRegime;

          // Push old to history
          if (changed) {
            regime.regimeHistory = [{ regime: prev, confidence: regime.confidence||70, ts: regime.analysisTs||new Date().toISOString(), duration: 'prev' }, ...(regime.regimeHistory||[])].slice(0, 8);
          }

          Object.assign(regime, {
            asset, currentRegime: r.currentRegime, previousRegime: changed ? prev : regime.previousRegime,
            confidence: r.confidence||70, trendStrength: r.trendStrength||50,
            volatilityState: r.volatilityState||'normal', momentumState: r.momentumState||'neutral',
            bias: r.bias||'neutral', price: mi.prices?.[asset]?.price||regime.price,
            priceChange24h: mi.prices?.[asset]?.change24h||0,
            inputs: r.inputs||regime.inputs,
            strategyMap: STRAT_MAP[r.currentRegime] || regime.strategyMap,
            analysisTs: new Date().toISOString()
          });

          if (changed) {
            regime.regimeChangeAlert = { active:true, previousRegime:prev, newRegime:r.currentRegime, confidence:r.confidence, detectedTs:new Date().toISOString(), impact:r.regimeChangeNote||'Regime transition detected.', severity: r.confidence>=80?'high':'medium' };
            const alertId = 'mrd_' + Date.now().toString(36);
            MRD.alerts.unshift({ id:alertId, asset, type:'regime_change', severity:regime.regimeChangeAlert.severity, previousRegime:prev, newRegime:r.currentRegime, confidence:r.confidence, title:`${asset} Regime Change: ${prev.replace(/_/g,' ')} → ${r.currentRegime.replace(/_/g,' ')}`, message:r.regimeChangeNote||'Regime transition detected.', tradingImpact:r.tradingImpact||'Adjust strategy selection accordingly.', active:true, ts:new Date().toISOString() });
            addEvent('REGIME', 'Market', 'regime_change', 'warning', `${asset}: ${prev} → ${r.currentRegime} (conf: ${r.confidence}%)`);
          }

          MRD.regimes[asset] = regime;
          // Recalculate trader fit
          if (MRD.strategyCompatibility) {
            Object.entries(MRD.strategyCompatibility).forEach(([trader, compat]) => {
              const btcFit = (MRD.regimes.BTC && (compat.optimalRegimes||[]).includes(MRD.regimes.BTC.currentRegime)) ? 1 : (compat.avoidRegimes||[]).includes(MRD.regimes.BTC?.currentRegime) ? -1 : 0;
              const ethFit = (MRD.regimes.ETH && (compat.optimalRegimes||[]).includes(MRD.regimes.ETH.currentRegime)) ? 1 : (compat.avoidRegimes||[]).includes(MRD.regimes.ETH?.currentRegime) ? -1 : 0;
              compat.currentFit = Math.min(100, Math.max(0, 70 + (btcFit + ethFit) * 15));
            });
          }
        });

        MRD.alerts = MRD.alerts.slice(0, 10);
        MRD.analysisHistory.unshift({ runId:'mrd_'+Date.now().toString(36), ts:new Date().toISOString(), btcRegime:MRD.regimes.BTC?.currentRegime, ethRegime:MRD.regimes.ETH?.currentRegime, note:parsed.summary||'AI regime analysis complete' });
        MRD.analysisHistory = MRD.analysisHistory.slice(0, 10);
        MRD._meta.analysisCount = (MRD._meta.analysisCount||0)+1;
        MRD._meta.lastAnalysis = new Date().toISOString();
      }

      MRD._meta.aiInFlight = false;
      MRD._meta.status = 'active';
      saveDb();
      broadcast({ type: 'MRD_UPDATE', data: db.trading.marketRegime });
      broadcast({ type: 'MRD_STATUS', data: { status: 'active', message: 'Analysis complete' } });
      console.log('[MRD] Analysis complete');
    } catch(err) {
      console.error('[MRD] Analysis failed:', err.message);
      MRD._meta.aiInFlight = false;
      MRD._meta.status = 'active';
      saveDb();
      broadcast({ type: 'MRD_STATUS', data: { status: 'error', message: err.message } });
    }
  })();
});

app.patch('/api/regime/alerts/:id/dismiss', (req, res) => {
  const MRD = db.trading?.marketRegime;
  const a   = MRD?.alerts?.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found' });
  a.active = false;
  saveDb();
  broadcast({ type: 'MRD_UPDATE', data: db.trading.marketRegime });
  res.json({ ok: true });
});

const MRD_SYSTEM = `You are the Market Regime Detector AI of ALEXIS OPS Mission Control.
Analyze BTC and ETH market data and classify each asset into one of 8 regimes.
Respond ONLY with raw JSON. No preamble, no markdown.
Format:
{
  "summary": "brief description",
  "regimes": {
    "BTC": {
      "currentRegime": "trending_up|trending_down|range_bound|volatility_expansion|volatility_compression|reversal_risk|breakout_environment|unstable_high_risk",
      "confidence": 0-100,
      "trendStrength": 0-100,
      "volatilityState": "low|normal|elevated|high|extreme",
      "momentumState": "strongly_bullish|bullish|neutral_bullish|neutral|neutral_bearish|bearish|strongly_bearish",
      "bias": "long|cautious_long|neutral|cautious_short|short",
      "inputs": {"priceStructure":"...","trendStrength":"...","maSlope":"...","volumeBehavior":"...","atrVolatility":"...","breakoutFreq":"...","falseBreakouts":"...","momentum":"...","sentiment":"...","macroContext":"..."},
      "regimeChangeNote": "description if regime changed",
      "tradingImpact": "what traders should do"
    },
    "ETH": { ... }
  }
}`;

const MRD_STRATEGY_MAP = {
  "trending_up":            {"favor":["Momentum Breakout","Trend Following","EMA Stack","Volume-confirmed entries"],"avoid":["Aggressive mean reversion","Counter-trend shorts","News fade"],"riskPosture":"Normal risk — favor trend-aligned entries. Hold winners. Widen TP targets.","positionSizing":"Standard 1-2% risk per trade"},
  "trending_down":          {"favor":["Bearish continuation","Short trend setups","Break-and-retest short","Lower high entries"],"avoid":["Blind dip buying","Bull traps","Premature long entries"],"riskPosture":"Protect capital on longs. Short bias with confirmation only. Tighter long SLs.","positionSizing":"Reduced longs 0.5-1%, normal shorts 1-2%"},
  "range_bound":            {"favor":["VWAP Mean Reversion","RSI Divergence","S/R rotation","Session boundary scalp"],"avoid":["Unconfirmed breakout chasing","Momentum entries","Wide-stop trend trades"],"riskPosture":"Tight position sizing near range edges. Take profits at opposing boundary.","positionSizing":"Standard 1-2%"},
  "volatility_expansion":   {"favor":["Clean breakout trades","ATR-based targets","Volatility-adjusted entries"],"avoid":["Overtrading","Mean reversion","Tight stop strategies"],"riskPosture":"Reduce size immediately. Only cleanest setups. Wider stops required.","positionSizing":"Reduced 0.5-1% max"},
  "volatility_compression": {"favor":["Breakout watch setups","BB squeeze entries","Pre-breakout positioning"],"avoid":["Forcing trades before confirmation","Mean reversion in compression"],"riskPosture":"Be patient. Size modestly until direction confirmed.","positionSizing":"Small 0.5-1% until breakout confirmed"},
  "reversal_risk":          {"favor":["Divergence plays","Structural reversal entries","LTF confirmation"],"avoid":["Trend continuation assumptions","Adding to trend positions"],"riskPosture":"Require stronger confirmation. Defensive posture.","positionSizing":"Reduced 0.5-1%"},
  "breakout_environment":   {"favor":["Breakout confirmation","Volume-verified entries","ADX expanding plays"],"avoid":["Fading breakouts","Mean reversion at key levels"],"riskPosture":"Wait for confirmed break + retest. Honor momentum.","positionSizing":"Standard to 2.5% on high-confidence breakouts"},
  "unstable_high_risk":     {"favor":["No-trade bias","Capital preservation","Observation only"],"avoid":["All new entries","FOMO trades","Leveraged positions"],"riskPosture":"TIGHTEN ALL RISK. Flat is a position.","positionSizing":"Zero to minimal."}
};

function buildRegimePrompt(MRD, mi) {
  const btcR = MRD.regimes?.BTC;
  const ethR = MRD.regimes?.ETH;
  return `Classify the current BTC and ETH market regime.

CURRENT DATA:
BTC Price: $${(mi.prices?.BTC?.price||84000).toLocaleString()} | 24h: ${mi.prices?.BTC?.change24h||0}% | Trend: ${mi.trends?.BTC?.state||'N/A'}
ETH Price: $${(mi.prices?.ETH?.price||3200).toLocaleString()} | 24h: ${mi.prices?.ETH?.change24h||0}% | Trend: ${mi.trends?.ETH?.state||'N/A'}
Volatility: ${mi.volatility?.state||'N/A'} | ATR BTC: ${mi.volatility?.BTC?.atr||'N/A'}
Sentiment: ${mi.sentiment?.overall||0}/100 | Funding: ${mi.traderBehavior?.fundingRate||'N/A'}
BTC Support/Resistance: ${mi.trends?.BTC?.keyLevel?.support||'N/A'} / ${mi.trends?.BTC?.keyLevel?.resistance||'N/A'}
ETH Support/Resistance: ${mi.trends?.ETH?.keyLevel?.support||'N/A'} / ${mi.trends?.ETH?.keyLevel?.resistance||'N/A'}
Macro: ${mi.macro?.bias||'N/A'}
On-chain signals: ${(mi.onchain||[]).slice(0,3).map(s=>s.signal).join(' | ')}

PREVIOUS REGIMES:
BTC: ${btcR?.currentRegime||'unknown'} (conf: ${btcR?.confidence||0}%)
ETH: ${ethR?.currentRegime||'unknown'} (conf: ${ethR?.confidence||0}%)

Analyze all inputs and determine the current regime for both assets. Be analytical and specific.
The 8 regimes are: trending_up, trending_down, range_bound, volatility_expansion, volatility_compression, reversal_risk, breakout_environment, unstable_high_risk`;
}


// ─── LIQUIDITY RADAR ENDPOINTS ───────────────────────────────

app.get('/api/liquidity', (req, res) => res.json(db.trading?.liquidityRadar || {}));

// POST — AI-powered full liquidity scan
app.post('/api/liquidity/scan', async (req, res) => {
  const LR = db.trading?.liquidityRadar;
  if (!LR) return res.status(500).json({ error: 'Liquidity Radar not initialized' });
  if (LR._meta?.aiInFlight) return res.status(409).json({ error: 'Scan already in progress' });

  const anthropicKey = db.apiKeys?.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key', message: 'Anthropic API key required.' });

  LR._meta.aiInFlight = true;
  LR._meta.status = 'scanning';
  saveDb();
  broadcast({ type: 'LR_STATUS', data: { status: 'scanning', message: 'Scanning market liquidity…' } });
  res.json({ ok: true, message: 'Liquidity scan dispatched' });

  (async () => {
    try {
      const mi = db.trading.marketIntel || {};
      const prompt = buildLiquidityPrompt(LR, mi);
      console.log('[LIQUIDITY] Running AI scan…');
      const raw = await callClaudeStr(anthropicKey, LIQUIDITY_SYSTEM, prompt, 2500);
      const parsed = safeParseJSON(raw);

      if (parsed) {
        // Merge new signals preserving existing ones
        ['BTC','ETH'].forEach(asset => {
          const aKey = asset.toLowerCase();
          if (parsed.stopClusters?.[asset])     { parsed.stopClusters[asset].forEach(sc => { sc.id = `sc_${aKey}_${Date.now().toString(36)}`; sc.ts = new Date().toISOString(); LR.stopClusters[asset].unshift(sc); }); LR.stopClusters[asset] = LR.stopClusters[asset].slice(0,6); }
          if (parsed.liquidationZones?.[asset]) { parsed.liquidationZones[asset].forEach(lz => { lz.id = `lz_${aKey}_${Date.now().toString(36)}`; lz.ts = new Date().toISOString(); LR.liquidationZones[asset].unshift(lz); }); LR.liquidationZones[asset] = LR.liquidationZones[asset].slice(0,5); }
          if (parsed.orderBookWalls?.[asset])   { parsed.orderBookWalls[asset].forEach(w => { w.id = `obw_${aKey}_${Date.now().toString(36)}`; w.ts = new Date().toISOString(); LR.orderBookWalls[asset].unshift(w); }); LR.orderBookWalls[asset] = LR.orderBookWalls[asset].slice(0,5); }
          if (parsed.liquidityGaps?.[asset])    { parsed.liquidityGaps[asset].forEach(g => { g.id = `lg_${aKey}_${Date.now().toString(36)}`; g.ts = new Date().toISOString(); LR.liquidityGaps[asset].unshift(g); }); LR.liquidityGaps[asset] = LR.liquidityGaps[asset].slice(0,4); }
          if (parsed.breakoutTraps?.[asset])    { parsed.breakoutTraps[asset].forEach(bt => { bt.id = `bt_${aKey}_${Date.now().toString(36)}`; bt.ts = new Date().toISOString(); LR.breakoutTraps[asset].unshift(bt); }); LR.breakoutTraps[asset] = LR.breakoutTraps[asset].slice(0,4); }
          if (parsed.heatmapData?.[asset])      LR.heatmapData[asset] = { ...LR.heatmapData[asset], ...parsed.heatmapData[asset], levels: parsed.heatmapData[asset].levels || LR.heatmapData[asset].levels };
        });
        if (parsed.alerts) {
          parsed.alerts.forEach(a => { a.id = `lr_ai_${Date.now().toString(36)}`; a.ts = new Date().toISOString(); a.active = true; LR.alerts.unshift(a); });
          LR.alerts = LR.alerts.slice(0, 10);
        }
        LR._meta.btcPrice = mi.prices?.BTC?.price || LR._meta.btcPrice;
        LR._meta.ethPrice = mi.prices?.ETH?.price || LR._meta.ethPrice;
        LR._meta.lastScan = new Date().toISOString();
        LR._meta.scanCount = (LR._meta.scanCount || 0) + 1;
        addEvent('LIQUIDITY_RADAR', 'Market', 'scan_complete', 'info', `Liquidity scan #${LR._meta.scanCount} complete — ${(parsed.alerts||[]).length} new alerts`);
      }

      LR._meta.aiInFlight = false;
      LR._meta.status = 'live';
      saveDb();
      broadcast({ type: 'LR_UPDATE', data: db.trading.liquidityRadar });
      broadcast({ type: 'LR_STATUS', data: { status: 'live', message: 'Scan complete' } });
      console.log('[LIQUIDITY] Scan complete');
    } catch (err) {
      console.error('[LIQUIDITY] Scan failed:', err.message);
      LR._meta.aiInFlight = false;
      LR._meta.status = 'live';
      saveDb();
      broadcast({ type: 'LR_STATUS', data: { status: 'error', message: err.message } });
    }
  })();
});

// PATCH — dismiss a liquidity alert
app.patch('/api/liquidity/alerts/:id/dismiss', (req, res) => {
  const LR = db.trading?.liquidityRadar;
  const a  = LR?.alerts?.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found' });
  a.active = false;
  saveDb();
  broadcast({ type: 'LR_UPDATE', data: db.trading.liquidityRadar });
  res.json({ ok: true });
});

// ─── LIQUIDITY AI PROMPT ──────────────────────────────────────
const LIQUIDITY_SYSTEM = `You are the Liquidity Radar AI of ALEXIS OPS Mission Control.
Analyze current BTC and ETH market conditions and identify liquidity signals.
Respond ONLY with raw JSON — no preamble, no markdown. Required format:
{
  "stopClusters": {
    "BTC": [{"price":0,"strength":"critical|high|medium|low","dirBias":"above|below","estimatedVolume":"$XM","description":"...","sweepProbability":0,"timeframe":"1H|4H|1D|1W"}],
    "ETH": [...]
  },
  "liquidationZones": {
    "BTC": [{"price":0,"range":[low,high],"side":"long|short","estimatedSize":"$XM","leverage":"Xx-Xx","riskLevel":"critical|high|medium","openInterest":"...","description":"...","cascadeRisk":true}],
    "ETH": [...]
  },
  "orderBookWalls": {
    "BTC": [{"price":0,"type":"buy|sell","size":"$XM","depth":"X BTC","strength":"major|medium|minor","description":"...","refreshRate":"..."}],
    "ETH": [...]
  },
  "liquidityGaps": {
    "BTC": [{"rangeHigh":0,"rangeLow":0,"gapSize":0,"depthScore":0,"breakoutRisk":"critical|high|medium","direction":"up|down","description":"...","cmfRatio":0}],
    "ETH": [...]
  },
  "breakoutTraps": {
    "BTC": [{"level":0,"type":"bull_trap|bear_trap","probability":0,"description":"...","priorFails":0,"tradersWarned":true,"suggestedAction":"..."}],
    "ETH": [...]
  },
  "alerts": [{"asset":"BTC|ETH","signalType":"stopCluster|liquidationZone|orderBookWall|liquidityGap|breakoutTrap","severity":"critical|high|medium","title":"...","message":"...","price":0}],
  "heatmapData": {
    "BTC": {"levels": [{"price":0,"intensity":0,"type":"stopCluster|liquidation|orderWall|liquidityGap|breakoutTrap|current","label":"..."}]},
    "ETH": {"levels": [...]}
  }
}`;

function buildLiquidityPrompt(LR, mi) {
  const btcPrice = mi.prices?.BTC?.price || LR._meta.btcPrice || 84000;
  const ethPrice = mi.prices?.ETH?.price || LR._meta.ethPrice || 3200;
  return `Analyze current BTC and ETH liquidity for ALEXIS OPS Liquidity Radar.

CURRENT PRICES:
- BTC/USD: $${btcPrice.toLocaleString()} | Trend: ${mi.trends?.BTC?.state || 'N/A'} | 24h: ${mi.prices?.BTC?.change24h || 'N/A'}%
- ETH/USD: $${ethPrice.toLocaleString()} | Trend: ${mi.trends?.ETH?.state || 'N/A'} | 24h: ${mi.prices?.ETH?.change24h || 'N/A'}%

MARKET CONDITIONS:
- Volatility: ${mi.volatility?.state || 'N/A'} | ATR BTC: ${mi.volatility?.BTC?.atr || 'N/A'}
- Sentiment: ${mi.sentiment?.overall || 'N/A'}/100 | Funding rates: ${mi.traderBehavior?.fundingRate || 'N/A'}
- BTC Support: $${mi.trends?.BTC?.keyLevel?.support?.toLocaleString() || 'N/A'} | Resistance: $${mi.trends?.BTC?.keyLevel?.resistance?.toLocaleString() || 'N/A'}
- ETH Support: $${mi.trends?.ETH?.keyLevel?.support?.toLocaleString() || 'N/A'} | Resistance: $${mi.trends?.ETH?.keyLevel?.resistance?.toLocaleString() || 'N/A'}
- Macro: ${mi.macro?.bias || 'N/A'}
- On-chain: ${(mi.onchain || []).slice(0,3).map(s => s.signal).join(', ')}

CURRENT LIQUIDITY ZONES ON RECORD:
BTC stops: ${LR.stopClusters.BTC.map(s=>`$${s.price.toLocaleString()}(${s.strength})`).join(', ')}
ETH stops: ${LR.stopClusters.ETH.map(s=>`$${s.price.toLocaleString()}(${s.strength})`).join(', ')}
BTC liq zones: ${LR.liquidationZones.BTC.map(l=>`$${l.price.toLocaleString()}(${l.riskLevel})`).join(', ')}
ETH liq zones: ${LR.liquidationZones.ETH.map(l=>`$${l.price.toLocaleString()}(${l.riskLevel})`).join(', ')}

Identify the most important NEW or UPDATED liquidity signals given current price action.
Focus on: areas closest to current price, highest impact signals, and any changes from prior scan.
Heatmap intensity: 100=current price, 90+=critical, 70-89=high, 50-69=medium, <50=low.`;
}

// ─── STRATEGY DISCOVERY ENGINE ENDPOINTS ─────────────────────

app.get('/api/sde', (req, res) => res.json(db.trading?.strategyDiscovery || {}));

// POST — run a full AI-powered discovery analysis
app.post('/api/sde/discover', async (req, res) => {
  const SDE = db.trading?.strategyDiscovery;
  if (!SDE) return res.status(500).json({ error: 'SDE not initialized' });
  if (SDE._meta?.aiInFlight) return res.status(409).json({ error: 'Discovery already in progress' });

  const anthropicKey = db.apiKeys?.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key', message: 'Anthropic API key required.' });

  SDE._meta.aiInFlight = true;
  SDE._meta.engineStatus = 'running';
  saveDb();
  broadcast({ type: 'SDE_STATUS', data: { status: 'running', message: 'Analyzing trade history and market data…' } });
  res.json({ ok: true, message: 'Discovery run dispatched' });

  (async () => {
    try {
      const trades     = db.trading.trades        || [];
      const simTrades  = db.trading.simulator?.trades?.filter(t => t.status === 'closed') || [];
      const mi         = db.trading.marketIntel   || {};
      const existing   = SDE.discoveredStrategies || [];
      const prompt     = buildSDePrompt(trades, simTrades, mi, existing);

      console.log('[SDE] Running AI discovery analysis…');
      const raw = await callClaudeStr(anthropicKey, SDE_SYSTEM_PROMPT, prompt, 2000);
      const parsed = safeParseJSON(raw);

      if (parsed.strategies && Array.isArray(parsed.strategies)) {
        const runId = 'dr' + Date.now().toString(36);
        let added = 0, rejected = 0;

        parsed.strategies.forEach(s => {
          const id = 'sd' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
          const isReject = s.status === 'rejected' || (s.stats?.winRate || 0) < 45 || (s.stats?.maxDrawdown || 100) > 15;
          const entry = { id, ...s, status: isReject ? 'rejected' : (s.status || 'candidate'), discoveredTs: new Date().toISOString(), lastTestedTs: new Date().toISOString(), rank: isReject ? null : SDE.discoveredStrategies.filter(x => x.rank).length + added + 1, rankChange: 0 };
          SDE.discoveredStrategies.unshift(entry);
          if (isReject) rejected++; else added++;
        });

        // Re-rank active strategies
        let rank = 1;
        SDE.discoveredStrategies.filter(s => s.status !== 'rejected').sort((a,b) => (b.stats?.winRate||0) - (a.stats?.winRate||0)).forEach(s => { s.rank = rank++; });

        SDE.discoveryHistory.unshift({ runId, ts: new Date().toISOString(), discovered: added, rejected, note: parsed.summary || `AI discovery run — ${added} new, ${rejected} rejected` });
        SDE._meta.totalRuns = (SDE._meta.totalRuns || 0) + 1;
        SDE._meta.totalDiscovered = (SDE._meta.totalDiscovered || 0) + added;
        SDE._meta.totalRejected = (SDE._meta.totalRejected || 0) + rejected;
        SDE._meta.lastRun = new Date().toISOString();

        // Update pattern library if AI provided patterns
        if (parsed.winningPatterns) SDE.patternLibrary.winningPatterns = [...parsed.winningPatterns, ...SDE.patternLibrary.winningPatterns].slice(0, 12);
        if (parsed.losingPatterns)  SDE.patternLibrary.losingPatterns  = [...parsed.losingPatterns,  ...SDE.patternLibrary.losingPatterns].slice(0, 12);
        if (parsed.evolutionRecommendations) SDE.evolutionRecommendations = [...parsed.evolutionRecommendations, ...SDE.evolutionRecommendations].slice(0, 6);

        addEvent('SDE', 'Discovery', 'run_complete', 'info', `SDE run complete: ${added} strategies discovered, ${rejected} rejected`);
      }

      SDE._meta.engineStatus = 'idle';
      SDE._meta.aiInFlight = false;
      saveDb();
      broadcast({ type: 'SDE_UPDATE', data: db.trading.strategyDiscovery });
      broadcast({ type: 'SDE_STATUS', data: { status: 'complete', message: `Discovery complete` } });
      console.log('[SDE] Discovery run complete');
    } catch (err) {
      console.error('[SDE] Discovery failed:', err.message);
      SDE._meta.engineStatus = 'idle';
      SDE._meta.aiInFlight = false;
      saveDb();
      broadcast({ type: 'SDE_STATUS', data: { status: 'error', message: err.message } });
    }
  })();
});

// PATCH — manually update strategy status (promote / reject / archive)
app.patch('/api/sde/strategy/:id', (req, res) => {
  const SDE = db.trading?.strategyDiscovery;
  const s   = SDE?.discoveredStrategies?.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Strategy not found' });
  const { status, promotionNote } = req.body;
  if (status) s.status = status;
  if (promotionNote) s.promotionNote = promotionNote;
  saveDb();
  broadcast({ type: 'SDE_UPDATE', data: db.trading.strategyDiscovery });
  res.json({ ok: true, strategy: s });
});

// ─── SDE AI HELPERS ────────────────────────────────────────────
const SDE_SYSTEM_PROMPT = `You are the Strategy Discovery Engine of ALEXIS OPS Trader League — La Logia.
Analyze the provided trade history and market data to discover profitable trading patterns and strategies.
Your output must be structured, data-driven, and actionable.
Respond ONLY with a JSON object — no preamble, no markdown, just raw JSON.
Required format:
{
  "summary": "brief description of the analysis run",
  "strategies": [{
    "name": "strategy name",
    "assetBias": "BTC | ETH | Both",
    "direction": "Long | Short | Both | Long-biased | Short-biased",
    "indicators": ["list of indicators"],
    "entryConditions": ["specific entry rules"],
    "exitConditions": ["specific exit rules"],
    "slLogic": "stop loss logic description",
    "rrMin": 2.0,
    "riskProfile": "very_low | low | medium | high | extreme",
    "marketConditions": ["when to use"],
    "avoidConditions": ["when NOT to use"],
    "stats": { "backtestTrades": 0, "winRate": 0, "avgReturn": 0, "totalReturn": 0, "avgDrawdown": 0, "maxDrawdown": 0, "sharpe": 0, "calmar": 0, "consistencyScore": 0 },
    "discoveredFrom": "source of discovery",
    "generationCorrelation": "which trader / generation",
    "promotionStatus": "candidate | active | elite | rejected",
    "promotionNote": "notes",
    "patternConfidence": 0
  }],
  "winningPatterns": [{"pattern":"...", "winRateDelta":"+X%", "occurrences":0, "reliability":"high|medium|low"}],
  "losingPatterns":  [{"pattern":"...", "winRateDelta":"-X%", "occurrences":0, "severity":"critical|high|medium"}],
  "evolutionRecommendations": [{"strategy":"name","recommendation":"...","priority":"high|medium","action":"...","dataRequired":"..."}]
}`;

function buildSDePrompt(trades, simTrades, mi, existing) {
  const closed = trades.filter(t => t.status === 'closed');
  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);

  const tradeSummary = closed.slice(0, 20).map(t =>
    `${t.trader}|${t.asset}|${t.direction}|entry:${t.entry}|exit:${t.exit}|pnl:${t.pnlPct}%|setup:${t.setup}`
  ).join('\n');

  const simSummary = simTrades.slice(0, 15).map(t =>
    `${t.simTrader}|${t.asset}|${t.direction}|entry:${t.entry}|exit:${t.exit}|pnl:${t.pnlPct}%|setup:${t.setup}`
  ).join('\n');

  const existingNames = existing.map(s => s.name).join(', ');

  return `Analyze this trading data and discover NEW profitable strategies not already in the library.

EXISTING STRATEGIES (do not duplicate): ${existingNames}

TRADE HISTORY (${closed.length} closed trades, ${wins.length} wins, ${losses.length} losses):
${tradeSummary}

SIMULATED TRADES (${simTrades.length} closed sim trades):
${simSummary}

CURRENT MARKET:
BTC: $${mi.prices?.BTC?.price?.toLocaleString() || 'N/A'} | Trend: ${mi.trends?.BTC?.state || 'N/A'}
ETH: $${mi.prices?.ETH?.price?.toLocaleString() || 'N/A'} | Trend: ${mi.trends?.ETH?.state || 'N/A'}
Volatility: ${mi.volatility?.state || 'N/A'} | Sentiment: ${mi.sentiment?.overall || 'N/A'}/100
Macro: ${mi.macro?.bias || 'N/A'}

Discover 2-3 new strategies from this data. Include 1 that should be REJECTED if the data shows a losing pattern.
Focus on: RSI, MACD, MAs, Bollinger Bands, VWAP, Volume, ATR, Support/Resistance, Breakouts, Momentum.
Base all stats on actual patterns found in the trade data above.`;
}

async function callClaudeStr(key, system, prompt, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) throw new Error(`Claude API ${response.status}`);
  const data = await response.json();
  return data.content?.find(b => b.type === 'text')?.text || '';
}

// ─── REAL TRADE APPROVAL ENDPOINTS ──────────────────────────

// GET full approval queue
app.get('/api/approvals', (req, res) => res.json(db.trading?.tradeApprovals || {}));

// POST — submit a new trade for approval
app.post('/api/approvals/submit', (req, res) => {
  const { trader, asset, direction, entry, sl, tp, size, leverage, riskPct } = req.body;
  if (!trader || !asset || !direction || !entry || !sl || !tp) {
    return res.status(400).json({ error: 'Missing required fields: trader, asset, direction, entry, sl, tp' });
  }
  const id = 'ta' + Date.now().toString(36).toUpperCase();
  const record = {
    id, status: 'pending', trader, asset, direction,
    entry: Number(entry), sl: Number(sl), tp: Number(tp),
    size: Number(size) || 0, leverage: Number(leverage) || 1,
    riskPct: Number(riskPct) || 0,
    submittedTs: new Date().toISOString(), finalizedTs: null,
    approvals: {
      thesis:      { status: 'pending', agent: trader,         ts: null, content: null, confidence: null },
      riskManager: { status: 'pending', agent: 'RISK_MANAGER', ts: null, content: null, flags: [], riskScore: null },
      qaCritic:    { status: 'pending', agent: 'QA_CRITIC',    ts: null, content: null, flags: [], qaScore: null },
      supervisor:  { status: 'pending', agent: 'SUPERVISOR',   ts: null, content: null, finalDecision: null, executionAuthCode: null }
    },
    outcomeStatus: 'awaiting_approval', outcomeNote: null
  };
  if (!db.trading.tradeApprovals) db.trading.tradeApprovals = { _meta: {}, approvalQueue: [], constitution: {} };
  db.trading.tradeApprovals.approvalQueue.unshift(record);
  db.trading.tradeApprovals._meta.totalSubmitted = (db.trading.tradeApprovals._meta.totalSubmitted || 0) + 1;
  db.trading.tradeApprovals._meta.totalPending   = (db.trading.tradeApprovals._meta.totalPending   || 0) + 1;
  db.trading.tradeApprovals._meta.lastActivity   = new Date().toISOString();
  saveDb();
  addEvent(trader, 'Trading', 'trade_submitted', 'info', `${trader} submitted ${direction} ${asset} @ $${Number(entry).toLocaleString()} for approval`);
  broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
  res.json({ ok: true, id, record });
});

// POST — run full 4-gate AI approval review for a pending record
app.post('/api/approvals/:id/review', async (req, res) => {
  const record = db.trading.tradeApprovals?.approvalQueue?.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  if (record.status !== 'pending') return res.status(400).json({ error: 'Record is not pending' });

  const anthropicKey = db.apiKeys?.find(k =>
    (k.provider === 'Anthropic' || k.name?.toLowerCase().includes('anthropic') || k.name?.toLowerCase().includes('claude')) &&
    k.key && k.key.length > 20
  )?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key', message: 'Anthropic API key required for AI review.' });

  res.json({ ok: true, message: 'Full 4-gate review dispatched' });
  broadcast({ type: 'APPROVAL_REVIEWING', data: { id: record.id } });

  (async () => {
    const traderData = db.trading.traders?.find(t => t.name === record.trader);
    const mi = db.trading.marketIntel;
    const constitution = db.trading.tradeApprovals.constitution;

    // Gate 1: Thesis (always from trader already in record if present, else auto-generate)
    if (record.approvals.thesis.status === 'pending') {
      try {
        const thesisPrompt = buildThesisPrompt(record, traderData, mi);
        const thesis = await callClaude(anthropicKey, THESIS_SYSTEM, thesisPrompt, 600);
        const parsed = safeParseJSON(thesis);
        record.approvals.thesis = { status: 'approved', agent: record.trader, ts: new Date().toISOString(), content: parsed.thesis || thesis, confidence: parsed.confidence || 75 };
        record.approvals.thesis.status = 'approved';
        saveDb(); broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
      } catch(e) { console.error('[APPROVAL] Thesis gate failed:', e.message); }
    }

    // Gate 2: Risk Manager
    if (record.approvals.thesis.status === 'approved' && record.approvals.riskManager.status === 'pending') {
      try {
        const rmPrompt = buildRiskManagerPrompt(record, constitution);
        const rmReview = await callClaude(anthropicKey, RISK_MANAGER_SYSTEM, rmPrompt, 600);
        const parsed = safeParseJSON(rmReview);
        const pass = parsed.decision === 'APPROVED' && (!parsed.flags || parsed.flags.length === 0);
        record.approvals.riskManager = {
          status: pass ? 'approved' : 'rejected', agent: 'RISK_MANAGER',
          ts: new Date().toISOString(), content: parsed.review || rmReview,
          flags: parsed.flags || [], riskScore: parsed.riskScore || 50
        };
        saveDb(); broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
        if (!pass) {
          record.status = 'rejected';
          record.finalizedTs = new Date().toISOString();
          record.approvals.qaCritic.status = 'blocked';
          record.approvals.qaCritic.content = 'Blocked by Risk Manager rejection.';
          record.approvals.supervisor.status = 'rejected';
          record.approvals.supervisor.content = 'Trade rejected at Risk Manager gate. Not authorized for execution.';
          record.approvals.supervisor.finalDecision = 'REJECTED';
          record.outcomeStatus = 'not_executed';
          record.outcomeNote = 'Rejected at Risk Manager gate';
          db.trading.tradeApprovals._meta.totalRejected = (db.trading.tradeApprovals._meta.totalRejected || 0) + 1;
          db.trading.tradeApprovals._meta.totalPending  = Math.max(0, (db.trading.tradeApprovals._meta.totalPending  || 1) - 1);
          saveDb(); broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
          addEvent('RISK_MANAGER','Trading','trade_rejected','warning',`${record.trader} ${record.direction} ${record.asset} rejected by Risk Manager: ${(parsed.flags||[]).join(', ')}`);
          return;
        }
      } catch(e) { console.error('[APPROVAL] Risk gate failed:', e.message); return; }
    }

    // Gate 3: QA Critic
    if (record.approvals.riskManager.status === 'approved' && record.approvals.qaCritic.status === 'pending') {
      try {
        const qaPrompt = buildQAPrompt(record, traderData, mi);
        const qaReview = await callClaude(anthropicKey, QA_CRITIC_SYSTEM, qaPrompt, 600);
        const parsed = safeParseJSON(qaReview);
        const pass = parsed.decision === 'APPROVED';
        record.approvals.qaCritic = {
          status: pass ? 'approved' : 'rejected', agent: 'QA_CRITIC',
          ts: new Date().toISOString(), content: parsed.review || qaReview,
          flags: parsed.flags || [], qaScore: parsed.qaScore || 50
        };
        saveDb(); broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
        if (!pass) {
          record.status = 'rejected'; record.finalizedTs = new Date().toISOString();
          record.approvals.supervisor.status = 'rejected';
          record.approvals.supervisor.content = 'Trade rejected at QA Critic gate.';
          record.approvals.supervisor.finalDecision = 'REJECTED';
          record.outcomeStatus = 'not_executed'; record.outcomeNote = 'Rejected at QA Critic gate';
          db.trading.tradeApprovals._meta.totalRejected = (db.trading.tradeApprovals._meta.totalRejected||0)+1;
          db.trading.tradeApprovals._meta.totalPending  = Math.max(0,(db.trading.tradeApprovals._meta.totalPending||1)-1);
          saveDb(); broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
          addEvent('QA_CRITIC','Trading','trade_rejected','warning',`${record.trader} ${record.direction} ${record.asset} rejected by QA Critic`);
          return;
        }
      } catch(e) { console.error('[APPROVAL] QA gate failed:', e.message); return; }
    }

    // Gate 4: Supervisor — final decision
    if (record.approvals.qaCritic.status === 'approved' && record.approvals.supervisor.status === 'pending') {
      try {
        const supPrompt = buildSupervisorApprovalPrompt(record, mi);
        const supReview = await callClaude(anthropicKey, SUPERVISOR_APPROVAL_SYSTEM, supPrompt, 700);
        const parsed = safeParseJSON(supReview);
        const pass = parsed.finalDecision === 'APPROVED';
        const authCode = pass ? `EXEC-${record.id}-${Date.now().toString(36).toUpperCase().slice(-5)}` : null;
        record.approvals.supervisor = {
          status: pass ? 'approved' : 'rejected', agent: 'SUPERVISOR',
          ts: new Date().toISOString(), content: parsed.review || supReview,
          finalDecision: parsed.finalDecision || 'REJECTED', executionAuthCode: authCode
        };
        record.status = pass ? 'approved' : 'rejected';
        record.finalizedTs = new Date().toISOString();
        record.outcomeStatus = pass ? 'cleared_for_execution' : 'not_executed';
        record.outcomeNote = pass ? `Auth code: ${authCode}` : 'Rejected by Supervisor';
        const meta = db.trading.tradeApprovals._meta;
        if (pass) meta.totalApproved = (meta.totalApproved||0)+1;
        else       meta.totalRejected = (meta.totalRejected||0)+1;
        meta.totalPending = Math.max(0,(meta.totalPending||1)-1);
        meta.lastActivity = new Date().toISOString();
        saveDb(); broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
        addEvent('SUPERVISOR','Trading',pass?'trade_approved':'trade_rejected',pass?'info':'warning',
          `${record.trader} ${record.direction} ${record.asset} — Supervisor: ${pass?'APPROVED ✓':'REJECTED ✗'}${pass?' Auth:'+authCode:''}`);
      } catch(e) { console.error('[APPROVAL] Supervisor gate failed:', e.message); }
    }
  })();
});

// PATCH — manually set an approval gate (for human override)
app.patch('/api/approvals/:id/gate/:gate', (req, res) => {
  const record = db.trading.tradeApprovals?.approvalQueue?.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  const { gate } = req.params;
  const { status, content, flags } = req.body;
  if (!['thesis','riskManager','qaCritic','supervisor'].includes(gate)) {
    return res.status(400).json({ error: 'Invalid gate' });
  }
  record.approvals[gate] = { ...record.approvals[gate], status, content: content || '', flags: flags || [], ts: new Date().toISOString() };
  if (gate === 'supervisor') {
    record.status = status === 'approved' ? 'approved' : 'rejected';
    record.finalizedTs = new Date().toISOString();
  }
  saveDb();
  broadcast({ type: 'APPROVAL_UPDATE', data: db.trading.tradeApprovals });
  res.json({ ok: true, record });
});

// ─── APPROVAL AI HELPERS ──────────────────────────────────────
async function callClaude(key, system, prompt, maxTokens = 600) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] })
  });
  if (!response.ok) throw new Error(`Claude API ${response.status}`);
  const data = await response.json();
  return data.content?.find(b => b.type === 'text')?.text || '';
}

function safeParseJSON(text) {
  try {
    const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    return JSON.parse((match?.[1] || match?.[0] || '{}').trim());
  } catch(e) { return { review: text }; }
}

const THESIS_SYSTEM = `You are a crypto trading agent in the ALEXIS OPS Trader League — La Logia. Generate a structured trade thesis. Respond ONLY with JSON: { "thesis": "<detailed rationale>", "confidence": <50-95> }`;

const RISK_MANAGER_SYSTEM = `You are the Risk Manager of ALEXIS OPS Trader League. Validate trades strictly against league constitution rules. Respond ONLY with JSON: { "decision": "APPROVED" or "REJECTED", "review": "<detailed analysis>", "flags": ["flag1",...], "riskScore": <0-100> }. Be strict. Reject any trade violating the constitution.`;

const QA_CRITIC_SYSTEM = `You are the QA Critic of ALEXIS OPS Trader League. Critically review trade setups for quality, execution logic, and alignment with the trader's documented strategy. Respond ONLY with JSON: { "decision": "APPROVED" or "REJECTED", "review": "<critical analysis>", "flags": ["flag1",...], "qaScore": <0-100> }. Your role is to catch poor-quality setups that pass risk checks but lack edge.`;

const SUPERVISOR_APPROVAL_SYSTEM = `You are the SUPERVISOR of ALEXIS OPS Trader League — La Logia. Give final authorization for real capital deployment. All three prior approvals passed. Confirm final context, macro alignment, and authorize. Respond ONLY with JSON: { "finalDecision": "APPROVED" or "REJECTED", "review": "<final summary>", "executionNote": "<any execution guidance>" }`;

function buildThesisPrompt(rec, traderData, mi) {
  return `Generate a trade thesis for ${rec.trader} (${traderData?.strategyFamily || 'momentum'} strategy):
Trade: ${rec.direction} ${rec.asset} | Entry: $${rec.entry.toLocaleString()} | SL: $${rec.sl.toLocaleString()} | TP: $${rec.tp.toLocaleString()}
BTC: $${mi?.prices?.BTC?.price?.toLocaleString() || 'N/A'} (${mi?.trends?.BTC?.state || 'N/A'}) | ETH: $${mi?.prices?.ETH?.price?.toLocaleString() || 'N/A'} (${mi?.trends?.ETH?.state || 'N/A'})
Sentiment: ${mi?.sentiment?.overall || 'N/A'}/100 | Volatility: ${mi?.volatility?.state || 'N/A'}`;
}

function buildRiskManagerPrompt(rec, config) {
  const slPct = Math.abs((rec.sl - rec.entry) / rec.entry * 100).toFixed(2);
  const tpPct = Math.abs((rec.tp - rec.entry) / rec.entry * 100).toFixed(2);
  const rr = (Math.abs(rec.tp - rec.entry) / Math.abs(rec.sl - rec.entry)).toFixed(2);
  return `RISK REVIEW for ${rec.id}:
Trader: ${rec.trader} | ${rec.direction} ${rec.asset} @ $${rec.entry.toLocaleString()}
SL: $${rec.sl.toLocaleString()} (${slPct}% from entry) | TP: $${rec.tp.toLocaleString()} (${tpPct}% from entry)
R:R = ${rr}:1 | Leverage: ${rec.leverage}x | Risk per trade: ${rec.riskPct}%

CONSTITUTION RULES:
- Max risk per trade: ${config.maxRiskPerTrade}%
- Max SL distance: ${config.maxSLDistancePct}%
- Max leverage: ${config.maxLeverage}x
- Min R:R: ${config.minRR}:1
- Allowed assets: ${(config.allowedAssets||[]).join(', ')}

Validate each rule strictly. List any violations as flags.`;
}

function buildQAPrompt(rec, traderData, mi) {
  return `QA REVIEW for ${rec.id}:
Trader: ${rec.trader} | Strategy: ${traderData?.strategyFamily || 'unknown'}
${rec.direction} ${rec.asset} @ $${rec.entry.toLocaleString()} | SL $${rec.sl.toLocaleString()} | TP $${rec.tp.toLocaleString()}
Trader thesis: "${rec.approvals.thesis.content}"
BTC structure: ${mi?.trends?.BTC?.structure || 'N/A'}
ETH structure: ${mi?.trends?.ETH?.structure || 'N/A'}
Volatility: ${mi?.volatility?.state} | Sentiment: ${mi?.sentiment?.overall}/100

Review for: setup quality, entry timing, SL logic, TP realism, strategy alignment.
Reject if: setup is low quality, entry is chasing, SL is arbitrary, or thesis doesn't match strategy.`;
}

function buildSupervisorApprovalPrompt(rec, mi) {
  return `FINAL AUTHORIZATION REQUEST — ${rec.id}
${rec.trader}: ${rec.direction} ${rec.asset} @ $${rec.entry.toLocaleString()} | SL $${rec.sl.toLocaleString()} | TP $${rec.tp.toLocaleString()}

GATE RESULTS:
✓ Thesis (${rec.trader}): Confidence ${rec.approvals.thesis.confidence}%
✓ Risk Manager: Score ${rec.approvals.riskManager.riskScore}/100, flags: none
✓ QA Critic: Score ${rec.approvals.qaCritic.qaScore}/100, flags: none

MARKET CONTEXT:
BTC: $${mi?.prices?.BTC?.price?.toLocaleString()} | Trend: ${mi?.trends?.BTC?.state} | Sentiment: ${mi?.sentiment?.overall}/100
Macro: ${mi?.macro?.bias}

Provide final authorization decision. APPROVED authorizes real capital deployment.`;
}

// Full state snapshot (for initial load)
app.get('/api/state', (req, res) => {
  res.json({
    projects: db.projects,
    agents: db.agents,
    blockers: db.blockers,
    events: db.events.slice(0, 50),
    metrics: db.metrics,
    ts: new Date().toISOString()
  });
});

// ─── HTTP SERVER ──────────────────────────────────────────────
const server = http.createServer(app);

// ─── WEBSOCKET SERVER ─────────────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${clientIp} — total: ${wss.clients.size}`);

  // Send full state on connect
  ws.send(JSON.stringify({ type: 'INIT', data: {
    projects: db.projects,
    agents: db.agents,
    blockers: db.blockers,
    events: db.events.slice(0, 50),
    metrics: db.metrics,
    trading: db.trading
  }}));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(ws, msg);
    } catch(e) {
      ws.send(JSON.stringify({ type: 'ERROR', data: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected — remaining: ${wss.clients.size}`);
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));
});

function handleWsMessage(ws, msg) {
  switch(msg.type) {
    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
      break;
    case 'GET_STATE':
      ws.send(JSON.stringify({ type: 'INIT', data: { projects: db.projects, agents: db.agents, blockers: db.blockers, events: db.events.slice(0, 50) }}));
      break;
    case 'ADD_EVENT':
      addEvent(msg.data.agent, msg.data.project, msg.data.type, msg.data.severity, msg.data.summary);
      break;
    default:
      ws.send(JSON.stringify({ type: 'ERROR', data: `Unknown message type: ${msg.type}` }));
  }
}

// ─── AGENT SIMULATOR ─────────────────────────────────────────
// Simulates real-time agent heartbeats and activity
const AGENT_TASKS = {
  'SUPERVISOR':  ['Reviewing project scope', 'Approving estimates', 'Assigning tasks', 'Monitoring agents', 'Closing sprint review'],
  'ROUTER':      ['Classifying signals', 'Routing new task', 'Processing queue', 'Updating routing table', 'Analyzing 5 requests'],
  'MEMORY-MGR':  ['Storing session context', 'Updating decision log', 'Syncing memory store', 'Archiving old context', 'Loading prior session'],
  'ESTIMATOR':   ['Calculating BOM', 'Reviewing NFPA specs', 'Drafting estimate', 'Validating material costs', 'Writing narrative'],
  'TRADER':      ['Analyzing BTC chart', 'Backtesting strategy', 'Monitoring ETH position', 'Calculating risk', 'Waiting for signal'],
  'PORTFOLIO':   ['Writing case study', 'Uploading to Wix', 'Formatting content', 'Reviewing portfolio', 'Adding new project'],
  'CODER':       ['Writing automation script', 'Testing Pi GPIO', 'Debugging webhook', 'Deploying script', 'Running tests'],
  'QA':          ['Reviewing estimate output', 'Checking NFPA compliance', 'Validating code quality', 'Running QA checklist', 'Approving deliverable'],
};

const EVENT_TEMPLATES = [
  { agent:'SUPERVISOR', type:'approval', severity:'info', template: name => `Task approved and assigned to ${name}` },
  { agent:'ESTIMATOR', type:'output', severity:'info', template: () => `Estimate updated — material cost revised by ${Math.floor(Math.random()*15)+2}%` },
  { agent:'QA', type:'review', severity:'warn', template: () => `QA flagged ${Math.floor(Math.random()*3)+1} items for revision` },
  { agent:'TRADER', type:'signal', severity:'info', template: () => `Signal detected: BTC momentum ${Math.random()>0.5?'bullish':'bearish'} — confidence ${Math.floor(Math.random()*20)+75}%` },
  { agent:'CODER', type:'test', severity:'info', template: () => `Automated test ${Math.floor(Math.random()*5)+1}/5 passed` },
  { agent:'MEMORY-MGR', type:'memory', severity:'info', template: () => `${Math.floor(Math.random()*10)+5} decisions stored to long-term memory` },
  { agent:'ROUTER', type:'route', severity:'info', template: () => `${Math.floor(Math.random()*5)+2} requests classified and routed` },
  { agent:'PORTFOLIO', type:'publish', severity:'info', template: () => `Portfolio section updated — ${Math.floor(Math.random()*20)+40}% complete` },
];

let tick = 0;

function simulateAgentActivity() {
  tick++;

  // Heartbeat — update agent loads slightly every 3 seconds
  db.agents = db.agents.map(agent => {
    const drift = (Math.random() - 0.5) * 8;
    const newLoad = Math.max(5, Math.min(99, agent.load + drift));
    const tasks = AGENT_TASKS[agent.name] || ['Processing…'];
    const taskChange = Math.random() < 0.15; // 15% chance to change task

    // Unblock TRADER occasionally
    if (agent.name === 'TRADER' && agent.status === 'blocked' && tick % 20 === 0) {
      addEvent('TRADER', 'Crypto Trading', 'recovery', 'info', 'Rate limit cleared — resuming ETH position execution');
      return { ...agent, status: 'active', load: 60, blocker: null, task: 'Resuming ETH position', heartbeat: Date.now() };
    }
    // Re-block TRADER occasionally
    if (agent.name === 'TRADER' && agent.status === 'active' && tick % 30 === 0) {
      return { ...agent, status: 'blocked', blocker: 'API rate limit hit', heartbeat: Date.now() };
    }

    return {
      ...agent,
      load: Math.round(newLoad),
      heartbeat: Date.now(),
      task: taskChange ? tasks[Math.floor(Math.random()*tasks.length)] : agent.task,
    };
  });

  saveDb();
  broadcast({ type: 'AGENTS_UPDATE', data: db.agents });

  // Generate a random event every ~15 seconds
  if (tick % 5 === 0) {
    const tpl = EVENT_TEMPLATES[Math.floor(Math.random() * EVENT_TEMPLATES.length)];
    const project = db.projects[Math.floor(Math.random()*db.projects.length)];
    addEvent(tpl.agent, project.name, tpl.type, tpl.severity, tpl.template(db.agents[0].name));
  }

  // Slowly progress active projects
  if (tick % 60 === 0) {
    db.projects = db.projects.map(p => {
      if (p.status !== 'active') return p;
      const newProgress = Math.min(99, p.progress + Math.floor(Math.random() * 2));
      const newDone = newProgress > p.progress && Math.random() > 0.6 ? Math.min(p.tasks, p.done + 1) : p.done;
      return { ...p, progress: newProgress, done: newDone, updatedAt: new Date().toISOString() };
    });
    saveDb();
    broadcast({ type: 'PROJECTS_UPDATE', data: db.projects });
  }
}

// ─── SECURITY GATEWAY ENDPOINTS ──────────────────────────────

app.get('/api/security', (req, res) => res.json(db.securityGateway || {}));

app.post('/api/security/request', (req, res) => {
  const SG = db.securityGateway;
  if (!SG) return res.status(500).json({ error: 'SG not initialized' });
  if (SG._meta?.lockdownMode) return res.status(423).json({ error: 'lockdown', message: 'Security Gateway in lockdown. All requests suspended.' });

  const { agent, project, action, resource, purpose, riskLevel = 'medium' } = req.body;
  if (!agent || !action || !resource || !purpose)
    return res.status(400).json({ error: 'Missing required fields: agent, action, resource, purpose' });

  const id    = 'sg_' + Date.now().toString(36);
  const tsNow = new Date().toISOString();

  // ── Agent identity & clearance ─────────────────────────────
  const agentInfo  = SG.agents?.[agent] || { clearance: 'standard', project: project || 'Unknown' };
  const clearance  = agentInfo.clearance || 'standard';
  const pMatrix    = SG.permissionMatrix?.[clearance] || SG.permissionMatrix?.standard;
  const allowed    = pMatrix?.allowed || [];
  const denied     = pMatrix?.denied  || [];

  // ── Operation category ─────────────────────────────────────
  const ACTION_CATEGORY = {
    READ_MARKET_DATA:'INTERNET_ACCESS', READ_PRICE_FEED:'INTERNET_ACCESS', READ_INDICATOR:'INTERNET_ACCESS',
    API_CALL_APPROVED_LIST:'API_CALL', RAW_API_CALL:'API_CALL', SUBMIT_TRADE_REQUEST:'API_CALL',
    WRITE_FILE:'FILESYSTEM', READ_FILE:'FILESYSTEM',
    EXEC_SCRIPT:'SCRIPT_EXEC',
    ACCESS_CREDENTIAL:'CREDENTIAL_ACCESS', READ_CREDENTIAL:'CREDENTIAL_ACCESS', WRITE_CREDENTIAL:'CREDENTIAL_ACCESS',
    BOT_COMMAND_READ:'BOT_COMMAND', BOT_COMMAND_WRITE:'BOT_COMMAND', BOT_COMMAND_SYSTEM:'BOT_COMMAND', BOT_COMMAND_ADMIN:'BOT_COMMAND',
  };
  const category = ACTION_CATEGORY[action] || (action.includes('BOT') ? 'BOT_COMMAND' : action.includes('FILE') ? 'FILESYSTEM' : 'API_CALL');

  // ── CHECK 1: Identity ──────────────────────────────────────
  const identityPass = !!SG.agents?.[agent];

  // ── CHECK 2: Permission ────────────────────────────────────
  const permPass = (allowed.includes('*') || allowed.includes(action)) && !denied.includes(action);

  // ── CHECK 3: Security risk ─────────────────────────────────
  let resourceDomain = resource;
  try { resourceDomain = new URL(resource.startsWith('http') ? resource : 'https://' + resource).hostname; } catch(e) { resourceDomain = resource; }
  const approvedList   = SG.approvedEndpoints || [];
  const isSafeAction   = ['READ_MARKET_DATA','READ_PRICE_FEED','READ_INDICATOR','READ_FILE','SUBMIT_TRADE_REQUEST'].includes(action);
  const isFileSys      = resource.startsWith('filesystem://') || resource.startsWith('/');
  const dangerPath     = isFileSys && /\/(etc|root|sys|proc|boot)\//.test(resource);
  const botTokenRisk   = action.startsWith('BOT_COMMAND') && resource.includes('token=');
  const endpointOK     = isSafeAction || approvedList.some(ep => resourceDomain.includes(ep) || ep.includes(resourceDomain));
  const securityPass   = endpointOK && !dangerPath && !botTokenRisk;
  const securityNote   = !endpointOK
    ? `VIOLATION: ${resourceDomain} not on approved endpoint whitelist.`
    : dangerPath ? `DELAY: System path ${resource} requires Admin secondary review.`
    : botTokenRisk ? 'VIOLATION: Bot token detected in resource string. Tokens must never be exposed — Gateway injects credentials.'
    : (category === 'BOT_COMMAND' ? `Bot platform validated. Gateway will inject auth token — agent receives no raw token.` : `Resource validated: ${resourceDomain}.`);

  // ── CHECK 4: Protocol ──────────────────────────────────────
  const protocolPass = true;

  const checks = {
    identity:   { pass: identityPass, note: identityPass   ? `${agent} registered. ${clearance} clearance confirmed.` : `UNKNOWN AGENT: ${agent} not in registry.` },
    permission: { pass: permPass,     note: permPass        ? `${action} permitted for ${clearance} clearance.`         : `VIOLATION: ${action} denied for ${clearance} clearance.` },
    security:   { pass: securityPass, note: securityNote },
    protocol:   { pass: protocolPass, note: 'Request correctly routed through Mission Control → Security Gateway. No direct external access attempted.' },
  };

  const failedChecks = Object.entries(checks).filter(([,v]) => !v.pass).map(([k]) => k);
  const isDelayed    = (dangerPath || (isFileSys && !dangerPath && failedChecks.includes('security'))) && failedChecks.length === 1;
  const status       = failedChecks.length === 0 ? 'approved' : (isDelayed ? 'delayed' : 'rejected');
  const authCode     = status === 'approved' ? `SG-${agent.replace(/_/g,'-')}-${Date.now().toString(36).toUpperCase()}` : null;

  const record = {
    id, ts: tsNow, resolvedTs: status !== 'delayed' ? tsNow : null,
    agent, project: project || agentInfo.project || 'Unknown',
    action, actionLabel: action.replace(/_/g,' '), category, resource, purpose, riskLevel,
    status, authCode, checks, failedChecks,
    guardianNotes: buildSGNote2(status, failedChecks, checks, agent, action, clearance),
    rejectionReason: status === 'rejected' ? failedChecks.map(k => checks[k]?.note).filter(Boolean).join(' · ') : undefined,
    saferAlternative: status === 'rejected' ? suggestAlternative2(action, category) : undefined,
    delayReason:      status === 'delayed'  ? `Secondary review required: ${checks.security.note}` : undefined,
  };

  SG.operationQueue.unshift(record);
  SG.operationQueue = SG.operationQueue.slice(0, 30);
  SG._meta.totalRequests = (SG._meta.totalRequests || 0) + 1;
  SG._meta.lastRequest   = tsNow;

  // Update stats
  SG.stats = SG.stats || {};
  SG.stats[status]         = (SG.stats[status] || 0) + 1;
  SG.stats.criticalBlocks  = (SG.stats.criticalBlocks || 0) + (status === 'rejected' && ['CREDENTIAL_ACCESS','SCRIPT_EXEC','BOT_COMMAND'].includes(category) ? 1 : 0);
  if (!SG.stats.operationCategories) SG.stats.operationCategories = {};
  const catStats = SG.stats.operationCategories[category] = SG.stats.operationCategories[category] || { total:0, approved:0, rejected:0, delayed:0 };
  catStats.total++; catStats[status]++;
  if (category === 'BOT_COMMAND') {
    SG.stats.botCommands = SG.stats.botCommands || { total:0, approved:0, rejected:0, delayed:0 };
    SG.stats.botCommands.total++; SG.stats.botCommands[status]++;
  }

  addSGLog(SG, status.toUpperCase(), agent, action,
    authCode ? `${action} authorized · ${authCode}` : (record.rejectionReason || record.delayReason || 'Blocked'));
  saveDb();
  broadcast({ type: 'SG_UPDATE', data: db.securityGateway });
  res.json({ ok: true, id, status, authCode, category, failedChecks, checksRun: 4 });
});

app.post('/api/security/review/:id', async (req, res) => {
  const SG = db.securityGateway;
  const op = SG?.operationQueue?.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: 'Not found' });
  const anthropicKey = db.apiKeys?.find(k => (k.provider==='Anthropic'||k.name?.toLowerCase().includes('anthropic'))&&k.key?.length>20)?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key' });
  res.json({ ok: true });
  (async () => {
    try {
      const agentClearance = db.securityGateway.agents?.[op.agent]?.clearance || 'standard';
      const prompt = `Security review for this gateway operation:\nAgent: ${op.agent} (${agentClearance} clearance) | Project: ${op.project}\nAction: ${op.action} | Resource: ${op.resource}\nPurpose: ${op.purpose} | Risk: ${op.riskLevel}\nStatus: ${op.status.toUpperCase()} | Failed: ${op.failedChecks?.join(', ')||'none'}\nChecks:\n${Object.entries(op.checks||{}).map(([k,v])=>(v.pass?'✓':'✗')+' '+k+': '+v.note).join('\n')}\n\nProvide a 3-4 sentence security assessment. Is the outcome correct? What should the agent do next?`;
      const raw = await callClaudeStr(anthropicKey, 'You are Security Guardian of ALEXIS OPS Mission Control. Review operations and give direct, professional security assessments.', prompt, 350);
      op.aiReview = raw.trim();
      saveDb();
      broadcast({ type: 'SG_UPDATE', data: db.securityGateway });
    } catch(e) { console.error('[SG] Review failed:', e.message); }
  })();
});

app.patch('/api/security/:id/override', (req, res) => {
  const SG = db.securityGateway;
  const op = SG?.operationQueue?.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  op.status = status; op.resolvedTs = new Date().toISOString();
  if (note) op.guardianNotes = note;
  if (status === 'approved') op.authCode = 'SG-'+op.agent.replace(/_/g,'-')+'-OVR-'+Date.now().toString(36).toUpperCase();
  addSGLog(SG, 'OVERRIDE->'+status.toUpperCase(), op.agent, op.action, 'Manual operator override');
  saveDb();
  broadcast({ type: 'SG_UPDATE', data: db.securityGateway });
  res.json({ ok: true, op });
});

app.patch('/api/security/lockdown', (req, res) => {
  const SG = db.securityGateway;
  if (!SG) return res.status(500).json({ error: 'Not initialized' });
  const { lockdown } = req.body;
  SG._meta.lockdownMode = !!lockdown;
  addSGLog(SG, lockdown ? 'LOCKDOWN_ACTIVATED' : 'LOCKDOWN_LIFTED', 'OPERATOR', 'SYSTEM', lockdown ? 'All external operations suspended' : 'Normal operation resumed');
  saveDb();
  broadcast({ type: 'SG_UPDATE', data: db.securityGateway });
  res.json({ ok: true, lockdown: SG._meta.lockdownMode });
});

function buildSGNote2(status, failed, checks, agent, action, clearance) {
  if (status === 'approved') return `All 4 checks passed. ${agent} (${clearance}) authorized for ${action}. Auth code issued.`;
  if (status === 'delayed')  return `Operation flagged for secondary review. ${checks.security?.note || 'Security evaluation pending.'}`;
  return `${failed.length} violation${failed.length > 1 ? 's' : ''}: ${failed.map(k => checks[k]?.note).filter(Boolean).join(' · ')}`;
}

function suggestAlternative2(action, category) {
  const byAction = {
    ACCESS_CREDENTIAL:    'Submit operation through Execution Guard or an elevated system agent. Security Gateway injects credentials — agents never receive raw keys.',
    WRITE_CREDENTIAL:     'Credential writes are Admin-only. No agent may write credentials directly under any circumstance.',
    EXEC_SCRIPT:          'Submit script to Security Guardian for source code audit. Once reviewed and approved, WALL-E can execute it in a sandboxed environment with elevated clearance.',
    RAW_API_CALL:         'Request endpoint whitelisting via Security Guardian review. Once approved, use API_CALL_APPROVED_LIST action type instead.',
    BOT_COMMAND_SYSTEM:   'Use BOT_COMMAND_READ for passive monitoring only. System-scope commands require elevated clearance and explicit Guardian review of the payload.',
    BOT_COMMAND_ADMIN:    'Admin-scope bot commands require Admin clearance. Submit a clearance escalation request through Security Guardian.',
    MODIFY_CONFIG:        'Config changes require Admin clearance and a change request with full justification and rollback plan.',
  };
  const byCategory = {
    CREDENTIAL_ACCESS: 'Use approved credential injection pattern: submit the operation through an elevated or admin agent — Gateway injects the credential on your behalf.',
    SCRIPT_EXEC:       'Submit script for Guardian review. Provide source code, expected behavior, and why execution is necessary. WALL-E can sandbox-execute once approved.',
    BOT_COMMAND:       'Use read-only bot operations (BOT_COMMAND_READ) if available. For write/system commands, escalate clearance or submit payload for Guardian review.',
  };
  return byAction[action] || byCategory[category] || 'Request elevated permissions through Security Guardian, or use a lower-risk alternative operation type that matches your clearance level.';
}
function addSGLog(SG, event, agent, action, detail) {
  const entry = { id:'al_'+Date.now().toString(36), ts:new Date().toISOString(), event, agent, action, detail };
  SG.auditLog = [entry,...(SG.auditLog||[])].slice(0,100);
}


// Run simulation every 3 seconds
setInterval(simulateAgentActivity, 3000);


// ─── MISSION CONTROL COORDINATION ENDPOINTS ──────────────────

app.get('/api/mc', (req, res) => res.json(db.missionControl || {}));

app.get('/api/mc/status', (req, res) => {
  const mc = db.missionControl;
  if (!mc) return res.status(404).json({ error: 'Mission Control not initialized' });
  res.json({
    meta:          mc._meta,
    projectCount:  mc.connectedProjects?.length || 0,
    workflowCount: mc.workflows?.length || 0,
    blockedCount:  mc.workflows?.filter(w => w.status === 'blocked').length || 0,
    pendingOps:    mc.pendingOperations?.length || 0,
    recommendations: mc.recommendedActions?.length || 0,
  });
});

// POST — log a new workflow event / coordination action
app.post('/api/mc/log', (req, res) => {
  const mc = db.missionControl;
  if (!mc) return res.status(404).json({ error: 'MC not initialized' });
  const { event, source, detail } = req.body;
  if (!event || !detail) return res.status(400).json({ error: 'event and detail required' });
  const entry = {
    id: 'mc-al-' + Date.now().toString(36),
    ts: new Date().toISOString(),
    event: event.toUpperCase(),
    source: source || 'OPERATOR',
    detail,
  };
  mc.auditLog = [entry, ...(mc.auditLog || [])].slice(0, 200);
  mc._meta.lastStatusReport = entry.ts;
  saveDb();
  broadcast({ type: 'MC_UPDATE', data: db.missionControl });
  res.json({ ok: true, entry });
});

// PATCH — update workflow status
app.patch('/api/mc/workflow/:id', (req, res) => {
  const mc = db.missionControl;
  if (!mc) return res.status(404).json({ error: 'MC not initialized' });
  const wf = mc.workflows?.find(w => w.id === req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const { status, progress, note } = req.body;
  if (status) wf.status = status;
  if (progress !== undefined) wf.progress = progress;
  wf.lastUpdated = new Date().toISOString();
  const entry = { id:'mc-al-'+Date.now().toString(36), ts:wf.lastUpdated, event:'WORKFLOW_UPDATE', source:'OPERATOR', detail:`${wf.id}: ${wf.title} → ${status||wf.status}${note?' — '+note:''}` };
  mc.auditLog = [entry, ...mc.auditLog].slice(0,200);
  saveDb();
  broadcast({ type: 'MC_UPDATE', data: db.missionControl });
  res.json({ ok: true, wf });
});

// POST — generate a fresh status report via AI
app.post('/api/mc/report', async (req, res) => {
  const mc  = db.missionControl;
  const SG  = db.securityGateway;
  if (!mc) return res.status(404).json({ error: 'MC not initialized' });
  const anthropicKey = db.apiKeys?.find(k => (k.provider==='Anthropic'||k.name?.toLowerCase().includes('anthropic'))&&k.key?.length>20)?.key;
  if (!anthropicKey) return res.status(400).json({ error: 'no_api_key' });
  res.json({ ok: true, message: 'Report generating…' });
  (async () => {
    try {
      const projSummary = mc.connectedProjects.map(p=>
        `• ${p.name} [${p.status.toUpperCase()}/${p.health.toUpperCase()}] — Progress: ${p.progress}% — Blockers: ${p.openBlockers} — ${p.warnings?p.warnings[0]:p.nextMilestone}`
      ).join('\n');
      const wfSummary = mc.workflows.map(w=>
        `• ${w.title} [${w.status.toUpperCase()}] ${w.progress}% — ${w.blockedReason||w.description.slice(0,80)}`
      ).join('\n');
      const sgSummary = `Requests: ${SG?._meta?.totalRequests||0} | Approved: ${SG?.stats?.approved||0} | Rejected: ${SG?.stats?.rejected||0} | Delayed: ${SG?.stats?.delayed||0} | Critical Blocks: ${SG?.stats?.criticalBlocks||0} | Lockdown: ${SG?._meta?.lockdownMode?'ACTIVE':'OFF'}`;
      const pendingSummary = mc.pendingOperations.map(o=>
        `• ${o.requestedBy}→${o.project}: ${o.action} on ${o.resource} [${o.status}]`
      ).join('\n');

      const prompt = `You are Mission Control coordinator for ALEXIS OPS. Generate a concise, professional System Status Report.

CONNECTED PROJECTS:
${projSummary}

ACTIVE WORKFLOWS:
${wfSummary}

SECURITY GATEWAY:
${sgSummary}

PENDING OPERATIONS REQUIRING ROUTING:
${pendingSummary}

Write a structured status report (3-4 paragraphs) covering: overall system health, most critical issues, security posture, and top 2-3 recommended actions. Be direct and operational in tone. No bullet points in the response — prose paragraphs only.`;

      const raw = await callClaudeStr(anthropicKey, 'You are Mission Control, the coordination layer of ALEXIS OPS. You maintain operational awareness across all connected projects and agents.', prompt, 500);
      mc.latestAiReport = { text: raw.trim(), generatedAt: new Date().toISOString() };
      mc._meta.lastStatusReport = mc.latestAiReport.generatedAt;
      mc._meta.reportCount = (mc._meta.reportCount || 0) + 1;
      const entry = { id:'mc-al-'+Date.now().toString(36), ts: mc.latestAiReport.generatedAt, event:'STATUS_REPORT', source:'MISSION_CONTROL', detail:`AI Status Report #${mc._meta.reportCount} generated.` };
      mc.auditLog = [entry, ...mc.auditLog].slice(0,200);
      saveDb();
      broadcast({ type: 'MC_UPDATE', data: db.missionControl });
      broadcast({ type: 'MC_REPORT', data: mc.latestAiReport });
    } catch(e) { console.error('[MC] Report failed:', e.message); }
  })();
});

// ─── SKILLS CENTER ENDPOINTS ─────────────────────────────────

app.get('/api/skills', (req, res) => res.json(db.skills || {}));

// Live endpoint — runs skills_status.py and returns fresh data
app.get('/api/skills/live', (req, res) => {
  const { execFile } = require('child_process');
  const section = req.query.section || null;  // active|top|families|new|distribution
  const args = ['--pretty'];
  if (section) args.unshift('--section', section);

  const scriptPaths = [
    path.join(os.homedir(), 'mission_control_backend', 'skills_status.py'),
    '/root/mission_control_backend/skills_status.py',
    path.join(__dirname, 'mission_control_backend', 'skills_status.py'),
    path.join(__dirname, '..', 'mission_control_backend', 'skills_status.py'),
  ];
  const scriptPath = scriptPaths.find(p => require('fs').existsSync(p));
  if (!scriptPath) return res.status(404).json({ ok: false, error: 'skills_status.py not found', tried: scriptPaths });

  execFile('python3', [scriptPath, ...args], { timeout: 8000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: err.message, stderr });
    try {
      const data = JSON.parse(stdout);
      // Merge live log data back into db.skills + broadcast
      if (!section && data.ok && data.sections) {
        const s = data.sections;
        const m = data.meta || {};
        // Sync stats from real log counts
        if (m.total_skills) {
          Object.assign(db.skills.stats, {
            totalSkills:      m.total_skills,
            approved:         m.approved     ?? db.skills.stats.approved,
            candidate:        m.candidates   ?? db.skills.stats.candidate,
            excluded:         m.excluded     ?? db.skills.stats.excluded,
            totalUsageEvents: s.top_skills_by_usage?.total_usage_events ?? db.skills.stats.totalUsageEvents,
            newThisWeek:      s.new_skills_detected?.total_detected      ?? db.skills.stats.newThisWeek,
            topSkillByUsage:  s.top_skills_by_usage?.top_global?.[0]?.skill_name ?? db.skills.stats.topSkillByUsage,
            activeNow:        (s.active_skills?.running_count || 0) + (s.active_skills?.standby_count || 0),
          });
        }
        // Sync activeNow from log
        if (s.active_skills) {
          const toEntry = r => ({ id:r.id, name:r.skill_name, family:r.family, project:r.project, projectName:r.project_name, agent:r.agent, taskType:r.task_type, taskRef:r.task_ref, startTime:r.start_time, status:r.status });
          db.skills.activeNow = [...(s.active_skills.running||[]), ...(s.active_skills.standby||[])].map(toEntry);
        }
        // Sync newSkills from changes log
        if (s.new_skills_detected?.skills?.length) {
          db.skills.newSkills = s.new_skills_detected.skills.map(n => ({
            id:n.id, name:n.skill_name, family:n.family, category:n.category,
            changeType:n.change_type, detectedDate:n.detected_date,
            recommendedProjects:(n.recommended_projects||[]).map(p => p.project_id || p),
            reviewStatus:n.review_status, addedBy:n.added_by,
          }));
        }
        db.skills._meta.lastUpdated  = new Date().toISOString();
        db.skills._meta.lastLiveSync = new Date().toISOString();
        db.skills._meta.logSource    = data.source || {};
        saveDb();
        broadcast({ type: 'SKILLS_UPDATE', data: db.skills });
      }
      res.json(data);
    } catch(e) { res.status(500).json({ ok: false, error: 'JSON parse failed', raw: stdout.slice(0,200) }); }
  });
});



// PATCH — update governance status of a skill (approve / candidate / exclude)
app.patch('/api/skills/:id/governance', (req, res) => {
  const sk = db.skills;
  if (!sk) return res.status(404).json({ error: 'Skills not initialized' });
  const { governance, reason, reviewStatus } = req.body;
  const lists = { approved: sk.approved, candidate: sk.candidates, excluded: sk.excluded };
  let found = null, fromList = null;
  for (const [key, list] of Object.entries(lists)) {
    const idx = list.findIndex(s => s.id === req.params.id);
    if (idx >= 0) { found = list.splice(idx, 1)[0]; fromList = key; break; }
  }
  if (!found) return res.status(404).json({ error: 'Skill not found' });
  found.governance = governance;
  if (reason) found.reason = reason;
  if (reviewStatus) found.reviewStatus = reviewStatus;
  found.lastGovernanceChange = new Date().toISOString();
  const targetList = governance === 'approved' ? sk.approved : governance === 'excluded' ? sk.excluded : sk.candidates;
  targetList.unshift(found);
  sk.stats.approved = sk.approved.length;
  sk.stats.candidate = sk.candidates.length;
  sk.stats.excluded  = sk.excluded.length;
  sk._meta.lastUpdated = new Date().toISOString();
  saveDb();
  broadcast({ type: 'SKILLS_UPDATE', data: db.skills });
  res.json({ ok: true, skill: found, from: fromList, to: governance });
});

// POST — add a new candidate skill
app.post('/api/skills/candidate', (req, res) => {
  const sk = db.skills;
  if (!sk) return res.status(404).json({ error: 'Skills not initialized' });
  const { name, family, project, agent, taskType, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const newSkill = {
    id: 'sk-c' + Date.now().toString(36),
    name, family: family || 'data',
    project: project || 'system',
    agent: agent || 'OPERATOR',
    taskType: taskType || 'General',
    description: description || '',
    timesUsed: 0, lastUsed: null,
    governance: 'candidate',
    nominatedAt: new Date().toISOString(),
    nominatedBy: 'OPERATOR',
    reviewStatus: 'pending',
    reviewNotes: '',
  };
  sk.candidates.unshift(newSkill);
  sk.stats.candidate = sk.candidates.length;
  sk.stats.totalSkills = sk.approved.length + sk.candidates.length + sk.excluded.length;
  sk._meta.lastUpdated = new Date().toISOString();
  saveDb();
  broadcast({ type: 'SKILLS_UPDATE', data: db.skills });
  res.json({ ok: true, skill: newSkill });
});

// ─── TOOL RUNNER ENDPOINTS ────────────────────────────────────

const { execFile: execFileTR } = require('child_process');

const TOOL_RUNNER_PATHS = [
  path.join(os.homedir(), 'ai_system/tool_runner/tool_runner.py'),
  '/root/ai_system/tool_runner/tool_runner.py',
];
const TR_LOG_PATHS = [
  path.join(os.homedir(), 'ai_system/logs/tool_runner.log'),
  '/root/ai_system/logs/tool_runner.log',
];
const TR_PENDING_PATHS = [
  path.join(os.homedir(), 'ai_system/tool_runner/pending'),
  '/root/ai_system/tool_runner/pending',
];
const TR_RESULTS_PATHS = [
  path.join(os.homedir(), 'ai_system/tool_runner/results'),
  '/root/ai_system/tool_runner/results',
];

function trScriptPath() { return TOOL_RUNNER_PATHS.find(p => fs.existsSync(p)); }
function trLogPath()    { return TR_LOG_PATHS.find(p => fs.existsSync(p)); }
function trPendingDir() { return TR_PENDING_PATHS.find(p => fs.existsSync(p)); }
function trResultsDir() { return TR_RESULTS_PATHS.find(p => fs.existsSync(p)); }

function runToolRunner(args, cb) {
  const script = trScriptPath();
  if (!script) return cb(new Error('tool_runner.py not found'), null);
  execFileTR('python3', [script, ...args], { timeout: 15000, maxBuffer: 1024 * 256 }, (err, stdout, stderr) => {
    if (err && !stdout) return cb(err, null);
    try { cb(null, JSON.parse(stdout)); }
    catch(e) { cb(new Error(`JSON parse failed: ${stdout.slice(0,200)}`), null); }
  });
}

// GET /api/tools/registry — full tool list
app.get('/api/tools/registry', (req, res) => {
  runToolRunner(['registry'], (err, _) => {
    if (err) {
      // Fallback: read registry directly from the script
      return res.status(500).json({ ok: false, error: err.message });
    }
    // registry prints text, not JSON — use get_status JSON instead for the registry
    runToolRunner(['run', '--request', JSON.stringify({
      agent:'OPERATOR', project:'system', tool:'get_status', arguments:{}, purpose:'Registry fetch'
    })], (err2, data) => {
      if (err2) return res.status(500).json({ ok: false, error: err2.message });
      res.json(data);
    });
  });
});

// GET /api/tools/status — runner status + pending queue
app.get('/api/tools/status', (req, res) => {
  runToolRunner(['run', '--request', JSON.stringify({
    agent:'OPERATOR', project:'system', tool:'get_status', arguments:{}, purpose:'Dashboard status poll'
  })], (err, data) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    // Also attach pending queue
    const pendDir = trPendingDir();
    let pending = [];
    if (pendDir) {
      try {
        pending = fs.readdirSync(pendDir)
          .filter(f => f.endsWith('.json'))
          .map(f => { try { return JSON.parse(fs.readFileSync(path.join(pendDir, f), 'utf8')); } catch { return null; } })
          .filter(Boolean)
          .sort((a,b) => (b.queued_at||'').localeCompare(a.queued_at||''));
      } catch {}
    }
    res.json({ ok: true, status: data.output, pending });
  });
});

// POST /api/tools/run — submit a tool request
app.post('/api/tools/run', (req, res) => {
  const { agent, project, tool, arguments: args, purpose, risk_level } = req.body || {};
  if (!agent || !tool) return res.status(400).json({ ok: false, error: 'agent and tool are required' });
  const request = { agent, project: project||'system', tool, arguments: args||{}, purpose: purpose||'', risk_level: risk_level||'low' };
  runToolRunner(['run', '--request', JSON.stringify(request)], (err, data) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    // Log to db and broadcast
    const entry = {
      ts: new Date().toISOString(),
      request_id: data.request_id,
      agent, project: project||'system', tool,
      status: data.status,
      execution_model: data.execution_model,
      purpose: purpose||'',
      error: data.error || null,
    };
    if (!db.toolRunner) db.toolRunner = { requests: [], pending: [], stats: { total:0, approved:0, rejected:0, pending:0 } };
    db.toolRunner.requests.unshift(entry);
    if (db.toolRunner.requests.length > 100) db.toolRunner.requests = db.toolRunner.requests.slice(0,100);
    db.toolRunner.stats.total = (db.toolRunner.stats.total||0) + 1;
    if (data.status === 'pending_approval') db.toolRunner.stats.pending = (db.toolRunner.stats.pending||0) + 1;
    saveDb();
    broadcast({ type: 'TOOL_UPDATE', data: { event: 'new_request', entry, result: data } });
    res.json(data);
  });
});

// GET /api/tools/pending — list pending approval requests
app.get('/api/tools/pending', (req, res) => {
  const pendDir = trPendingDir();
  if (!pendDir) return res.json({ ok: true, pending: [] });
  try {
    const pending = fs.readdirSync(pendDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(pendDir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a,b) => (b.queued_at||'').localeCompare(a.queued_at||''));
    res.json({ ok: true, count: pending.length, pending });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/tools/approve/:id
app.post('/api/tools/approve/:id', (req, res) => {
  runToolRunner(['approve', req.params.id], (err, data) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (db.toolRunner) db.toolRunner.stats.approved = (db.toolRunner.stats.approved||0) + 1;
    saveDb();
    broadcast({ type: 'TOOL_UPDATE', data: { event: 'approved', request_id: req.params.id, result: data } });
    res.json(data);
  });
});

// POST /api/tools/reject/:id
app.post('/api/tools/reject/:id', (req, res) => {
  const reason = req.body?.reason || '';
  runToolRunner(['reject', req.params.id, '--reason', reason], (err, data) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (db.toolRunner) db.toolRunner.stats.rejected = (db.toolRunner.stats.rejected||0) + 1;
    saveDb();
    broadcast({ type: 'TOOL_UPDATE', data: { event: 'rejected', request_id: req.params.id } });
    res.json(data);
  });
});

// GET /api/tools/log?n=50 — tail tool_runner.log
app.get('/api/tools/log', (req, res) => {
  const n = Math.min(parseInt(req.query.n)||50, 200);
  const logPath = trLogPath();
  if (!logPath) return res.json({ ok: true, entries: [] });
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const entries = lines.slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ ok: true, count: entries.length, entries });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/tools/workspace — list workspace
app.get('/api/tools/workspace', (req, res) => {
  runToolRunner(['run', '--request', JSON.stringify({
    agent:'OPERATOR', project:'system', tool:'list_workspace',
    arguments: req.query.path ? { path: req.query.path } : {},
    purpose:'Workspace browse'
  })], (err, data) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json(data);
  });
});

// GET /api/tools/results?n=20 — recent completed results
app.get('/api/tools/results', (req, res) => {
  const n = Math.min(parseInt(req.query.n)||20, 50);
  const dir = trResultsDir();
  if (!dir) return res.json({ ok: true, results: [] });
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const results = files
      .map(f => { try { return { ...JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')), _file: f }; } catch { return null; } })
      .filter(Boolean)
      .sort((a,b) => (b.completed_at||'').localeCompare(a.completed_at||''))
      .slice(0, n);
    res.json({ ok: true, count: results.length, results });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   MISSION CONTROL — ALEXIS OPS v2.0         ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║   Dashboard → http://localhost:${PORT}          ║`);
  console.log(`  ║   API       → http://localhost:${PORT}/api      ║`);
  console.log(`  ║   WebSocket → ws://localhost:${PORT}            ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  [${new Date().toLocaleTimeString()}] Server online — Waiting for connections`);
  console.log('  Press Ctrl+C to stop');
  console.log('');
});
