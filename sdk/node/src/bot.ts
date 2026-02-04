/**
 * Agent Poker SDK — Bot Class
 *
 * Handles the entire game loop: poll for state, check if it's your turn,
 * call your strategy, submit actions, and handle errors/reconnection.
 *
 * Usage:
 *   const bot = new Bot(client, {
 *     strategy: (state) => {
 *       if (state.availableActions.includes('check')) return { action: 'check' };
 *       return { action: 'fold' };
 *     }
 *   });
 *   bot.start();
 */

import { EventEmitter } from 'events';
import { AgentPokerClient, AgentPokerClientError } from './client';
import { GameState, StrategyFunction, StrategyResult, StrategyLike, ActionType } from './types';

export interface BotOptions {
  /** Your strategy function — receives game state, returns an action */
  strategy: StrategyFunction;
  /** Poll interval in milliseconds (default: 2000) */
  pollInterval?: number;
  /** Auto-rejoin if disconnected from table (default: true) */
  autoRejoin?: boolean;
  /** Table ID to join (default: "main") */
  tableId?: string;
  /** Enable verbose console logging (default: false) */
  verbose?: boolean;
  /** Auto-join table on start (default: true) */
  autoJoin?: boolean;
}

export interface BotEvents {
  handStart: (state: GameState) => void;
  handEnd: (state: GameState) => void;
  myTurn: (state: GameState) => void;
  bust: (chips: number) => void;
  error: (error: Error) => void;
  action: (result: StrategyResult, state: GameState) => void;
  connected: () => void;
  disconnected: () => void;
}

export class Bot extends EventEmitter {
  private client: AgentPokerClient;
  private strategy: StrategyFunction;
  private pollInterval: number;
  private autoRejoin: boolean;
  private tableId: string;
  private verbose: boolean;
  private autoJoin: boolean;

  private running = false;
  private lastHandId: string | null = null;
  private lastPhase: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: AgentPokerClient, options: BotOptions) {
    super();
    this.client = client;
    this.strategy = options.strategy;
    this.pollInterval = options.pollInterval ?? 2000;
    this.autoRejoin = options.autoRejoin ?? true;
    this.tableId = options.tableId ?? 'main';
    this.verbose = options.verbose ?? false;
    this.autoJoin = options.autoJoin ?? true;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Start the bot — joins the table and begins the game loop */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.log('🃏 Agent Poker Bot starting...');

    // Graceful shutdown on SIGINT
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Join table
    if (this.autoJoin) {
      await this.joinTable();
    }

    // Start polling
    this.log(`📡 Polling every ${this.pollInterval}ms`);
    this.poll();
  }

  /** Stop the bot gracefully */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.log('👋 Bot stopped');
    this.emit('disconnected');
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async joinTable(): Promise<void> {
    try {
      const result = await this.client.join(this.tableId);
      this.log(`✅ Joined table: ${result.tableId}`);
      this.emit('connected');
    } catch (err) {
      if (err instanceof AgentPokerClientError) {
        // Already at table is fine
        if (err.statusCode === 400 && err.response?.error?.includes('already')) {
          this.log('ℹ️  Already at table');
          this.emit('connected');
          return;
        }
      }
      throw err;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const state = await this.client.state();
      await this.processState(state);
    } catch (err) {
      await this.handleError(err as Error);
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
    }
  }

  private async processState(state: GameState): Promise<void> {
    // Detect new hand
    if (state.handId && state.handId !== this.lastHandId) {
      if (this.lastHandId !== null) {
        this.emit('handEnd', state);
      }
      this.lastHandId = state.handId;
      this.lastPhase = state.phase;
      this.emit('handStart', state);
      this.logVerbose(`🂠 New hand: ${state.handId} | Cards: ${state.yourCards.join(' ')}`);
    }

    // Detect phase change
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase;
      this.logVerbose(`📋 Phase: ${state.phase} | Board: ${state.communityCards.join(' ') || '—'} | Pot: $${state.pot}`);
    }

    // Detect bust
    if (state.yourChips <= 0 && state.phase === 'waiting') {
      this.emit('bust', state.yourChips);
      this.log('💀 Busted! Chips: 0');
    }

    // Act if it's our turn
    if (state.isYourTurn && state.availableActions.length > 0) {
      this.emit('myTurn', state);
      await this.takeAction(state);
    }
  }

  private async takeAction(state: GameState): Promise<void> {
    try {
      // Call the strategy function
      const raw = await Promise.resolve(this.strategy(state));
      const decision: StrategyResult = {
        action: raw.action as ActionType,
        amount: raw.amount,
        chat: raw.chat,
      };

      // Validate the action is available
      if (!state.availableActions.includes(decision.action)) {
        this.log(`⚠️  Strategy returned "${decision.action}" but available actions are: ${state.availableActions.join(', ')}. Folding.`);
        await this.client.act({ action: 'fold' });
        return;
      }

      // Submit the action
      await this.client.act({
        action: decision.action,
        amount: decision.amount,
      });

      this.emit('action', decision, state);
      this.log(`🎯 ${decision.action.toUpperCase()}${decision.amount ? ` $${decision.amount}` : ''} | Pot: $${state.pot} | Cards: ${state.yourCards.join(' ')}`);

      // Send chat if the strategy included one
      if (decision.chat) {
        try {
          await this.client.chat(decision.chat);
          this.logVerbose(`💬 "${decision.chat}"`);
        } catch {
          // Chat errors are non-critical
        }
      }
    } catch (err) {
      this.log(`❌ Action failed: ${(err as Error).message}`);
      this.emit('error', err as Error);

      // Try to fold as a fallback
      try {
        if (state.availableActions.includes('fold')) {
          await this.client.act({ action: 'fold' });
          this.log('🔄 Fell back to fold');
        }
      } catch {
        // Nothing more we can do
      }
    }
  }

  private async handleError(err: Error): Promise<void> {
    if (err instanceof AgentPokerClientError) {
      // Not at a table — try to rejoin
      if (err.statusCode === 400 && err.response?.error?.includes('Not at a table') && this.autoRejoin) {
        this.log('🔄 Not at table, attempting to rejoin...');
        try {
          await this.joinTable();
        } catch (joinErr) {
          this.log(`❌ Rejoin failed: ${(joinErr as Error).message}`);
        }
        return;
      }

      // Rate limited — back off
      if (err.statusCode === 429) {
        this.log('⏳ Rate limited, backing off...');
        await this.sleep(5000);
        return;
      }
    }

    // Network errors — log but keep going
    if ((err as any).name === 'AbortError' || (err as any).code === 'ECONNREFUSED') {
      this.logVerbose(`🌐 Network error: ${err.message}`);
      return;
    }

    this.log(`❌ Error: ${err.message}`);
    this.emit('error', err);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${msg}`);
  }

  private logVerbose(msg: string): void {
    if (this.verbose) this.log(msg);
  }
}
