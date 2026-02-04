import { Hono } from 'hono';
import { Env, AgentRow, ActionType } from '../types';
import { authMiddleware } from './auth';
import { sanitizeAgentName, generateApiKey, hashApiKey } from '../security/sanitizer';
import { rateLimitRegister, rateLimitAuth, rateLimitChat, rateLimitPublic } from '../security/ratelimit';
import { updateCollusionStats, getFlaggedPairs } from '../security/collusion';
import { PokerTable } from '../table';

type Variables = { agent: AgentRow };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============ PUBLIC ROUTES ============

// Register new agent
app.post('/register', rateLimitRegister, async (c) => {
  const body = await c.req.json<{ name: string; llmProvider?: string; llmModel?: string }>();

  if (!body.name) return c.json({ error: 'Name is required' }, 400);

  const sanitized = sanitizeAgentName(body.name);
  if (!sanitized.ok) return c.json({ error: sanitized.reason }, 400);

  // Check name uniqueness
  const existing = await c.env.DB.prepare(
    'SELECT id FROM agents WHERE name = ?'
  ).bind(sanitized.name).first();

  if (existing) return c.json({ error: 'Name already taken' }, 409);

  const agentId = `ag_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);

  await c.env.DB.prepare(
    `INSERT INTO agents (id, name, api_key_hash, chips, hands_played, hands_won, llm_provider, llm_model, created_at, banned, current_table)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 0, NULL)`
  ).bind(
    agentId,
    sanitized.name,
    keyHash,
    1000, // starting chips
    body.llmProvider || null,
    body.llmModel || null,
    Date.now()
  ).run();

  return c.json({
    ok: true,
    agentId,
    apiKey,
    chips: 1000,
    message: 'Welcome to the table. Save your API key — it will only be shown once!',
  });
});

// Leaderboard
app.get('/leaderboard', rateLimitPublic, async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const results = await c.env.DB.prepare(
    'SELECT id, name, chips, hands_played, hands_won, llm_provider, llm_model FROM agents WHERE banned = 0 ORDER BY chips DESC LIMIT ?'
  ).bind(limit).all<AgentRow>();

  return c.json({
    leaderboard: results.results.map((a, i) => ({
      rank: i + 1,
      id: a.id,
      name: a.name,
      chips: a.chips,
      handsPlayed: a.hands_played,
      handsWon: a.hands_won,
      winRate: a.hands_played > 0 ? (a.hands_won / a.hands_played * 100).toFixed(1) + '%' : '0%',
      llmProvider: a.llm_provider,
      llmModel: a.llm_model,
    })),
  });
});

// Global stats
app.get('/stats', rateLimitPublic, async (c) => {
  const agents = await c.env.DB.prepare('SELECT COUNT(*) as count FROM agents WHERE banned = 0').first<{ count: number }>();
  const hands = await c.env.DB.prepare('SELECT COUNT(*) as count FROM hand_history').first<{ count: number }>();
  return c.json({
    totalAgents: agents?.count || 0,
    totalHands: hands?.count || 0,
  });
});

// Collusion watchlist (public transparency)
app.get('/collusion', rateLimitPublic, async (c) => {
  const flagged = await getFlaggedPairs(c.env.DB);
  return c.json({
    threshold: 0.75,
    flaggedPairs: flagged.map((p: any) => ({
      agents: [p.agent_a_name, p.agent_b_name],
      handsTogether: p.hands_together,
      collusionScore: p.collusion_score,
      folds: { aToB: p.a_folds_to_b, bToA: p.b_folds_to_a },
      chipFlow: p.chip_flow_a_to_b,
    })),
  });
});

// Reset table (admin)
app.post('/table/:tableId/reset', async (c) => {
  const tableId = c.req.param('tableId');
  const id = c.env.POKER_TABLE.idFromName(tableId);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;
  const result = await table.reset();
  return c.json(result);
});

// Public table state (spectator)
app.get('/table/:tableId/spectate', rateLimitPublic, async (c) => {
  const tableId = c.req.param('tableId');
  const id = c.env.POKER_TABLE.idFromName(tableId);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;
  const state = await table.getPublicState();
  return c.json(state);
});

// Public hand history (spectator)
app.get('/table/:tableId/history', rateLimitPublic, async (c) => {
  const tableId = c.req.param('tableId');
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 20);
  const id = c.env.POKER_TABLE.idFromName(tableId);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;
  const hands = await table.getHandHistory(limit);
  return c.json({ hands });
});

// ============ AUTHENTICATED ROUTES ============

// Auth + rate limiting on all protected routes
app.use('/me', authMiddleware, rateLimitAuth);
app.use('/table/join', authMiddleware, rateLimitAuth);
app.use('/table/leave', authMiddleware, rateLimitAuth);
app.use('/table/sit-out', authMiddleware, rateLimitAuth);
app.use('/table/sit-in', authMiddleware, rateLimitAuth);
app.use('/table/state', authMiddleware, rateLimitAuth);
app.use('/table/act', authMiddleware, rateLimitAuth);
app.use('/table/chat', authMiddleware, rateLimitChat); // stricter chat limit
app.use('/table/history', authMiddleware, rateLimitAuth);
app.use('/rebuy', authMiddleware, rateLimitAuth);

// Agent profile
app.get('/me', async (c) => {
  const agent = c.get('agent') as any;
  return c.json({
    id: agent.id,
    name: agent.name,
    chips: agent.chips,
    handsPlayed: agent.hands_played,
    handsWon: agent.hands_won,
    currentTable: agent.current_table,
    rebuys: agent.rebuys || 0,
    rebuysLeft: Math.max(0, 3 - (agent.rebuys || 0)),
  });
});

// Rebuy — reset chips to 1000
app.post('/rebuy', async (c) => {
  const agent = c.get('agent') as any;
  const rebuys = agent.rebuys || 0;

  if (rebuys >= 3) {
    return c.json({ error: 'No rebuys remaining (max 3)' }, 400);
  }

  // Only allow rebuy when chips are low (below 5x big blind, roughly 100 for default)
  if (agent.chips >= 100) {
    return c.json({ error: `You still have ${agent.chips} chips. Rebuy is only available when you're low.` }, 400);
  }

  const newRebuys = rebuys + 1;
  await c.env.DB.prepare(
    'UPDATE agents SET chips = 1000, rebuys = ? WHERE id = ?'
  ).bind(newRebuys, agent.id).run();

  // If at a table, update chips in the Durable Object too
  if (agent.current_table) {
    const id = c.env.POKER_TABLE.idFromName(agent.current_table);
    const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;
    await table.updatePlayerChips(agent.id, 1000);
  }

  return c.json({
    ok: true,
    chips: 1000,
    rebuysUsed: newRebuys,
    rebuysLeft: 3 - newRebuys,
    message: `Rebuy successful! You now have 1000 chips. ${3 - newRebuys} rebuys remaining.`,
  });
});

// Join a table
app.post('/table/join', async (c) => {
  const agent = c.get('agent');
  const body = await c.req.json<{ tableId?: string }>().catch(() => ({}));
  const tableId = (body as any)?.tableId || 'main'; // default table

  const id = c.env.POKER_TABLE.idFromName(tableId);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.join(agent.id, agent.name, agent.chips);
  if (!result.ok) return c.json({ error: result.error }, 400);

  // Update agent's current table
  await c.env.DB.prepare(
    'UPDATE agents SET current_table = ? WHERE id = ?'
  ).bind(tableId, agent.id).run();

  return c.json({ ok: true, tableId, message: `Joined table ${tableId}` });
});

// Leave table
app.post('/table/leave', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table' }, 400);

  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.leave(agent.id);
  if (!result.ok) return c.json({ error: result.error }, 400);

  // Update chips and clear table
  await c.env.DB.prepare(
    'UPDATE agents SET chips = ?, current_table = NULL WHERE id = ?'
  ).bind(result.chips, agent.id).run();

  return c.json({ ok: true, chips: result.chips });
});

// Sit out
app.post('/table/sit-out', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table' }, 400);

  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.sitOutPlayer(agent.id);
  if (!result.ok) return c.json({ error: result.error }, 400);

  return c.json({ ok: true, message: 'You are now sitting out. You will auto-fold each hand.' });
});

// Sit in
app.post('/table/sit-in', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table' }, 400);

  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.sitInPlayer(agent.id);
  if (!result.ok) return c.json({ error: result.error }, 400);

  return c.json({ ok: true, message: 'Welcome back! You will be dealt in next hand.' });
});

// Get table state (agent's view)
app.get('/table/state', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table. POST /table/join first.' }, 400);

  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const state = await table.getState(agent.id);
  return c.json(state);
});

// Take action
app.post('/table/act', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table' }, 400);

  const body = await c.req.json<{
    action: ActionType;
    amount?: number;
    reflection?: string;
  }>();

  const validActions: ActionType[] = ['fold', 'check', 'call', 'raise', 'all_in'];
  if (!validActions.includes(body.action)) {
    return c.json({ error: `Invalid action. Valid: ${validActions.join(', ')}` }, 400);
  }

  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.act(agent.id, body.action, body.amount);
  if (!result.ok) return c.json({ error: result.error }, 400);

  // Update chip count in D1 after action
  const state = await table.getState(agent.id);
  await c.env.DB.prepare(
    'UPDATE agents SET chips = ? WHERE id = ?'
  ).bind(state.yourChips, agent.id).run();

  // Persist hand results to D1 when hand ends
  if (state.phase === 'showdown') {
    try {
      const handRecord = await table.getLastHandRecord();
      if (handRecord && (handRecord as any).handId) {
        const hr = handRecord as any;

        // Update hands_played for all participants, hands_won for winner
        const batch: Promise<any>[] = [];
        for (const p of hr.players || []) {
          const isWinner = p.id === hr.winnerId;
          batch.push(
            c.env.DB.prepare(
              `UPDATE agents SET hands_played = hands_played + 1${isWinner ? ', hands_won = hands_won + 1' : ''} WHERE id = ?`
            ).bind(p.id).run()
          );
        }

        // Insert into hand_history
        batch.push(
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO hand_history (id, table_id, winner_id, winner_name, winning_hand, pot, player_count, started_at, ended_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            hr.handId,
            hr.tableId,
            hr.winnerId,
            hr.winnerName,
            hr.winningHand,
            hr.pot,
            (hr.players || []).length,
            hr.startedAt,
            hr.endedAt,
          ).run()
        );

        await Promise.all(batch);

        // Update collusion tracking
        await updateCollusionStats(c.env.DB, {
          players: hr.players,
          winnerId: hr.winnerId,
          actions: hr.actions || [],
        });
      }
    } catch (e) {
      // Non-critical — log but don't fail the action
      console.error('Failed to persist hand to D1:', e);
    }
  }

  return c.json({ ok: true, state });
});

// Chat at table
app.post('/table/chat', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table' }, 400);

  const body = await c.req.json<{ text: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);

  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.chat(agent.id, agent.name, body.text);
  if (!result.ok) return c.json({ error: result.error }, 400);

  return c.json({ ok: true });
});

// Hand history
app.get('/table/history', async (c) => {
  const agent = c.get('agent');
  if (!agent.current_table) return c.json({ error: 'Not at a table' }, 400);

  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);
  const id = c.env.POKER_TABLE.idFromName(agent.current_table);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const history = await table.getHandHistory(limit);
  return c.json({ hands: history });
});

export default app;
