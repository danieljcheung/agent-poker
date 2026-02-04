import { DurableObject } from 'cloudflare:workers';
import { TableState, Env, ActionType } from './types';
import {
  createTable,
  addPlayer,
  removePlayer,
  startHand,
  canStartHand,
  processAction,
  getAgentView,
  addChat,
  handleTimeout,
  sitOut,
  sitIn,
  canLeave,
} from './engine/game';
import { sanitizeChat } from './security/sanitizer';

export class PokerTable extends DurableObject<Env> {
  private state: TableState;
  private autoPlayInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = createTable(ctx.id.toString());
    
    // Restore state from storage
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<TableState>('state');
      if (stored) {
        this.state = stored;
      }
    });
  }

  private async save() {
    await this.ctx.storage.put('state', this.state);
  }

  async join(agentId: string, name: string, chips: number): Promise<{ ok: boolean; error?: string }> {
    const result = addPlayer(this.state, agentId, name, chips);
    if ('error' in result) return { ok: false, error: result.error };
    this.state = result;
    await this.save();

    // Try to start a hand if enough players
    await this.tryStartHand();

    return { ok: true };
  }

  async leave(agentId: string): Promise<{ ok: boolean; chips: number; error?: string }> {
    // Check if player can leave (not in active hand)
    const check = canLeave(this.state, agentId);
    if (!check.ok) return { ok: false, chips: 0, error: check.error };

    const player = this.state.players.find(p => p.agentId === agentId);
    const chips = player?.chips || 0;
    this.state = removePlayer(this.state, agentId);
    await this.save();
    return { ok: true, chips };
  }

  async sitOutPlayer(agentId: string): Promise<{ ok: boolean; error?: string }> {
    const result = sitOut(this.state, agentId);
    if ('error' in result) return { ok: false, error: result.error };
    this.state = result;
    await this.save();
    return { ok: true };
  }

  async sitInPlayer(agentId: string): Promise<{ ok: boolean; error?: string }> {
    const result = sitIn(this.state, agentId);
    if ('error' in result) return { ok: false, error: result.error };
    this.state = result;
    await this.save();

    // Try to start a hand if enough players now
    await this.tryStartHand();

    return { ok: true };
  }

  async act(agentId: string, action: ActionType, amount?: number): Promise<{ ok: boolean; error?: string }> {
    const result = processAction(this.state, agentId, action, amount);
    if ('error' in result) return { ok: false, error: result.error };
    this.state = result;

    // If hand ended (showdown), save record and schedule next hand
    if (this.state.phase === 'showdown') {
      await this.saveHandRecord();
      // Use DO alarm to auto-start next hand after 3 seconds
      await this.ctx.storage.setAlarm(Date.now() + 3000);
    }

    await this.save();
    return { ok: true };
  }

  async chat(agentId: string, name: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const sanitized = sanitizeChat(text);
    if (!sanitized.ok) return { ok: false, error: sanitized.reason };

    this.state = addChat(this.state, agentId, name, sanitized.text);
    await this.save();
    return { ok: true };
  }

  async getState(agentId: string) {
    // Check for timeouts first
    const afterTimeout = handleTimeout(this.state);
    if (afterTimeout !== this.state) {
      this.state = afterTimeout;
      if (this.state.phase === 'showdown') {
        await this.saveHandRecord();
        await this.ctx.storage.setAlarm(Date.now() + 3000);
      }
      await this.save();
    }

    return getAgentView(this.state, agentId);
  }

  async getPublicState() {
    // Check for timeouts on spectator poll too
    const afterTimeout = handleTimeout(this.state);
    if (afterTimeout !== this.state) {
      this.state = afterTimeout;
      if (this.state.phase === 'showdown') {
        await this.saveHandRecord();
        await this.ctx.storage.setAlarm(Date.now() + 3000);
      }
      await this.save();
    }

    const turnPlayer = this.state.currentTurnIndex >= 0 ? this.state.players[this.state.currentTurnIndex] : null;
    const timeLeftMs = this.state.currentTurnIndex >= 0
      ? Math.max(0, this.state.actionTimeoutMs - (Date.now() - this.state.lastActionTime))
      : 0;

    // Reveal hole cards during showdown for active/all-in players
    const isShowdown = this.state.phase === 'showdown';
    const holeCardsMap: Record<string, string[]> = {};
    if (isShowdown && this.state.handRecord?.holeCards) {
      for (const p of this.state.players) {
        if (p.status === 'active' || p.status === 'all_in') {
          const cards = this.state.handRecord.holeCards[p.agentId];
          if (cards) holeCardsMap[p.agentId] = cards;
        }
      }
    }

    // Calculate blind positions
    const activePlayers = this.state.players.filter(p => p.status !== 'sitting_out');
    const dealerIndex = this.state.dealerIndex;
    const sbIndex = activePlayers.length === 2 ? dealerIndex : (dealerIndex + 1) % (activePlayers.length || 1);
    const bbIndex = (sbIndex + 1) % (activePlayers.length || 1);

    return {
      tableId: this.state.tableId,
      phase: this.state.phase,
      playerCount: this.state.players.length,
      players: this.state.players.map(p => ({
        id: p.agentId,
        name: p.name,
        chips: p.chips,
        status: p.status,
        bet: p.bet,
        holeCards: holeCardsMap[p.agentId] || null,
      })),
      pot: this.state.pot,
      communityCards: this.state.communityCards,
      handId: this.state.handId,
      currentTurn: turnPlayer ? { id: turnPlayer.agentId, name: turnPlayer.name } : null,
      timeLeftMs,
      actionTimeoutMs: this.state.actionTimeoutMs,
      recentChat: this.state.handRecord?.chat.slice(-10) || [],
      lastHandResult: this.state.lastHandResult || null,
      dealerIndex,
      smallBlindIndex: sbIndex,
      bigBlindIndex: bbIndex,
      smallBlind: this.state.smallBlind,
      bigBlind: this.state.bigBlind,
    };
  }

  // Durable Object alarm handler — auto-starts next hand
  async alarm() {
    await this.tryStartHand();
  }

  private async tryStartHand() {
    // Transition from showdown to waiting before starting new hand
    if (this.state.phase === 'showdown') {
      this.state = { ...this.state, phase: 'waiting' };
    }
    if (canStartHand(this.state)) {
      this.state = startHand(this.state);
      await this.save();
    }
  }

  private async saveHandRecord() {
    if (!this.state.handRecord) return;
    const record = this.state.handRecord;

    // Save to Durable Object storage (D1 save happens via API)
    const key = `hand:${record.handId}`;
    await this.ctx.storage.put(key, record);

    // Keep last 50 hands
    const hands = await this.ctx.storage.list<string>({ prefix: 'hand:' });
    if (hands.size > 50) {
      const keys = Array.from(hands.keys()).sort();
      const toDelete = keys.slice(0, keys.length - 50);
      for (const k of toDelete) {
        await this.ctx.storage.delete(k);
      }
    }
  }

  async updatePlayerChips(agentId: string, chips: number) {
    this.state = {
      ...this.state,
      players: this.state.players.map(p =>
        p.agentId === agentId ? { ...p, chips } : p
      ),
    };
    await this.save();
  }

  async reset() {
    this.state = createTable(this.ctx.id.toString());
    await this.ctx.storage.deleteAll();
    await this.save();
    return { ok: true };
  }

  // Lightweight summary for lobby listing — no timeout processing
  async getTableSummary(): Promise<{
    playerCount: number;
    maxPlayers: number;
    phase: string;
    smallBlind: number;
    bigBlind: number;
    avgStack: number;
    hasOpenSeats: boolean;
  }> {
    const activePlayers = this.state.players.filter(p => p.status !== 'sitting_out');
    const totalPlayers = this.state.players.length;
    const avgStack = totalPlayers > 0
      ? Math.round(this.state.players.reduce((s, p) => s + p.chips, 0) / totalPlayers)
      : 0;
    return {
      playerCount: totalPlayers,
      maxPlayers: 6,
      phase: this.state.phase,
      smallBlind: this.state.smallBlind,
      bigBlind: this.state.bigBlind,
      avgStack,
      hasOpenSeats: totalPlayers < 6,
    };
  }

  async getHandHistory(limit: number = 10) {
    const hands = await this.ctx.storage.list({ prefix: 'hand:' });
    const records = Array.from(hands.values()).slice(-limit);
    return records;
  }

  // Return the last completed hand record (for D1 persistence from Worker)
  async getLastHandRecord() {
    if (this.state.handRecord && this.state.handRecord.endedAt > 0) {
      return this.state.handRecord;
    }
    // Check storage for most recent
    const hands = await this.ctx.storage.list({ prefix: 'hand:' });
    const records = Array.from(hands.values());
    return records.length > 0 ? records[records.length - 1] : null;
  }
}
