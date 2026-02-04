import { Hono } from 'hono';
import { Env, AgentRow, ActionType } from '../types';
import { authMiddleware } from './auth';
import { sanitizeAgentName, generateApiKey, hashApiKey } from '../security/sanitizer';
import { rateLimitRegister, rateLimitAuth, rateLimitChat, rateLimitPublic } from '../security/ratelimit';
import { updateCollusionStats, getFlaggedPairs } from '../security/collusion';
import { PokerTable } from '../table';

type Variables = { agent: AgentRow };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============ ELO CALCULATION ============

function calculateExpected(myElo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - myElo) / 400));
}

function getEloBadge(elo: number): string {
  if (elo >= 1400) return '💎';
  if (elo >= 1200) return '🥇';
  if (elo >= 1000) return '🥈';
  return '🥉';
}

function getEloTier(elo: number): string {
  if (elo >= 1400) return 'Diamond';
  if (elo >= 1200) return 'Gold';
  if (elo >= 1000) return 'Silver';
  return 'Bronze';
}

async function updateEloRatings(
  db: D1Database,
  winnerId: string,
  playerIds: string[],
  isFoldWin: boolean
): Promise<void> {
  // Fetch current ELOs for all players
  const placeholders = playerIds.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT id, elo FROM agents WHERE id IN (${placeholders})`
  ).bind(...playerIds).all<{ id: string; elo: number }>();

  const eloMap = new Map<string, number>();
  for (const row of rows.results) {
    eloMap.set(row.id, row.elo ?? 1000);
  }

  const K = isFoldWin ? 16 : 32;
  const winnerElo = eloMap.get(winnerId) ?? 1000;
  const loserIds = playerIds.filter(id => id !== winnerId);

  // Pairwise ELO: winner vs each loser
  const eloChanges = new Map<string, number>();
  eloChanges.set(winnerId, 0);
  for (const loserId of loserIds) {
    eloChanges.set(loserId, 0);
  }

  for (const loserId of loserIds) {
    const loserElo = eloMap.get(loserId) ?? 1000;
    const expectedWinner = calculateExpected(winnerElo, loserElo);
    const expectedLoser = calculateExpected(loserElo, winnerElo);

    const winnerDelta = Math.round(K * (1 - expectedWinner));
    const loserDelta = Math.round(K * (0 - expectedLoser));

    eloChanges.set(winnerId, (eloChanges.get(winnerId) ?? 0) + winnerDelta);
    eloChanges.set(loserId, (eloChanges.get(loserId) ?? 0) + loserDelta);
  }

  // Batch update ELOs
  const updates: Promise<any>[] = [];
  for (const [id, delta] of eloChanges) {
    const currentElo = eloMap.get(id) ?? 1000;
    const newElo = Math.max(0, currentElo + delta); // Floor at 0
    updates.push(
      db.prepare('UPDATE agents SET elo = ? WHERE id = ?').bind(newElo, id).run()
    );
  }
  await Promise.all(updates);
}

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
  const sortBy = c.req.query('sort') === 'elo' ? 'elo' : 'chips';
  const orderClause = sortBy === 'elo' ? 'elo DESC' : 'chips DESC';
  const results = await c.env.DB.prepare(
    `SELECT id, name, chips, hands_played, hands_won, llm_provider, llm_model, elo FROM agents WHERE banned = 0 ORDER BY ${orderClause} LIMIT ?`
  ).bind(limit).all<AgentRow>();

  return c.json({
    leaderboard: results.results.map((a, i) => ({
      rank: i + 1,
      id: a.id,
      name: a.name,
      chips: a.chips,
      elo: a.elo ?? 1000,
      eloBadge: getEloBadge(a.elo ?? 1000),
      eloTier: getEloTier(a.elo ?? 1000),
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
  const tables = await c.env.DB.prepare('SELECT COUNT(*) as count FROM tables WHERE is_active = 1').first<{ count: number }>();
  return c.json({
    totalAgents: agents?.count || 0,
    totalHands: hands?.count || 0,
    activeTables: tables?.count || 0,
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

// List active tables with metadata
app.get('/tables', rateLimitPublic, async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id, created_at, last_active FROM tables WHERE is_active = 1 ORDER BY last_active DESC'
    ).all<{ id: string; created_at: number; last_active: number }>();

    const tables = await Promise.all(
      (rows.results || []).map(async (row) => {
        try {
          const doId = c.env.POKER_TABLE.idFromName(row.id);
          const table = c.env.POKER_TABLE.get(doId) as unknown as PokerTable;
          const summary = await table.getTableSummary();
          return {
            id: row.id,
            ...summary,
            createdAt: row.created_at,
            lastActive: row.last_active,
          };
        } catch {
          return null;
        }
      })
    );

    // Filter out nulls (failed DO calls) and inactive tables
    const activeTables = tables.filter(t => t !== null);

    // Cleanup: mark tables with 0 players for > 5 minutes as inactive (except "main")
    const now = Date.now();
    for (const t of activeTables) {
      if (t!.id !== 'main' && t!.playerCount === 0 && (now - t!.lastActive) > 5 * 60 * 1000) {
        await c.env.DB.prepare(
          'UPDATE tables SET is_active = 0 WHERE id = ?'
        ).bind(t!.id).run();
      }
    }

    const finalTables = activeTables.filter(t =>
      t!.id === 'main' || t!.playerCount > 0 || (now - t!.lastActive) <= 5 * 60 * 1000
    );

    return c.json({ tables: finalTables });
  } catch (e) {
    console.error('Tables listing error:', e);
    return c.json({ tables: [] });
  }
});

// Reset table (admin — requires ADMIN_KEY env var)
app.post('/table/:tableId/reset', async (c) => {
  const adminKey = c.req.header('X-Admin-Key');
  const expectedKey = c.env.ADMIN_KEY;
  if (!expectedKey || adminKey !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
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
  const state = await table.getPublicState() as any;

  // Enrich player data with ELO from D1
  if (state.players?.length > 0) {
    try {
      const playerIds = state.players.map((p: any) => p.id);
      const placeholders = playerIds.map(() => '?').join(',');
      const rows = await c.env.DB.prepare(
        `SELECT id, elo FROM agents WHERE id IN (${placeholders})`
      ).bind(...playerIds).all<{ id: string; elo: number }>();

      const eloMap = new Map<string, number>();
      for (const row of rows.results) {
        eloMap.set(row.id, row.elo ?? 1000);
      }

      state.players = state.players.map((p: any) => {
        const elo = eloMap.get(p.id) ?? 1000;
        return {
          ...p,
          elo,
          eloBadge: getEloBadge(elo),
          eloTier: getEloTier(elo),
        };
      });
    } catch (e) {
      // Non-critical — spectate still works without ELO
      console.error('Failed to fetch ELO for spectate:', e);
    }
  }

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
  const elo = agent.elo ?? 1000;
  return c.json({
    id: agent.id,
    name: agent.name,
    chips: agent.chips,
    elo,
    eloBadge: getEloBadge(elo),
    eloTier: getEloTier(elo),
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

// Join a table (with auto-seating)
app.post('/table/join', async (c) => {
  const agent = c.get('agent');
  const body = await c.req.json<{ tableId?: string }>().catch(() => ({}));
  let tableId = (body as any)?.tableId || '';

  // Auto-seat: find an open table if none specified
  if (!tableId) {
    try {
      const rows = await c.env.DB.prepare(
        'SELECT id FROM tables WHERE is_active = 1 ORDER BY last_active DESC'
      ).all<{ id: string }>();

      let foundTable = false;
      for (const row of rows.results || []) {
        const doId = c.env.POKER_TABLE.idFromName(row.id);
        const tbl = c.env.POKER_TABLE.get(doId) as unknown as PokerTable;
        const summary = await tbl.getTableSummary();
        if (summary.hasOpenSeats) {
          tableId = row.id;
          foundTable = true;
          break;
        }
      }

      // All tables full — create a new one
      if (!foundTable) {
        const countResult = await c.env.DB.prepare(
          'SELECT COUNT(*) as count FROM tables'
        ).first<{ count: number }>();
        const nextNum = (countResult?.count || 1) + 1;
        tableId = `table-${nextNum}`;

        await c.env.DB.prepare(
          'INSERT OR IGNORE INTO tables (id, created_at, last_active, is_active) VALUES (?, ?, ?, 1)'
        ).bind(tableId, Date.now(), Date.now()).run();
      }
    } catch (e) {
      // Fallback to main
      tableId = 'main';
    }
  }

  const id = c.env.POKER_TABLE.idFromName(tableId);
  const table = c.env.POKER_TABLE.get(id) as unknown as PokerTable;

  const result = await table.join(agent.id, agent.name, agent.chips);
  if (!result.ok) return c.json({ error: result.error }, 400);

  // Upsert the table record in D1 + update last_active
  await c.env.DB.prepare(
    'INSERT INTO tables (id, created_at, last_active, is_active) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET last_active = ?, is_active = 1'
  ).bind(tableId, Date.now(), Date.now(), Date.now()).run();

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

  // Update table last_active timestamp
  if (agent.current_table) {
    await c.env.DB.prepare(
      'UPDATE tables SET last_active = ? WHERE id = ?'
    ).bind(Date.now(), agent.current_table).run();
  }

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

        // Update ELO ratings
        if (hr.winnerId && hr.players?.length >= 2) {
          try {
            const isFoldWin = hr.winningHand === 'Last player standing';
            const playerIds = hr.players.map((p: any) => p.id);
            await updateEloRatings(c.env.DB, hr.winnerId, playerIds, isFoldWin);
          } catch (eloErr) {
            console.error('ELO update failed:', eloErr);
          }
        }
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
