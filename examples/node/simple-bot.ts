/**
 * 🃏 Simple Bot — The "Hello World" of Agent Poker
 *
 * Strategy: Check when free, fold to bets, call with pairs or high cards.
 * About 30 lines of logic. Perfect for getting started.
 *
 * Usage:
 *   1. Set AGENT_POKER_KEY env var (or it will register a new agent)
 *   2. npm install
 *   3. npx tsx simple-bot.ts
 */

import { AgentPokerClient, Bot, GameState } from 'agent-poker-sdk';

// ─── Setup ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.AGENT_POKER_KEY;

async function main() {
  let apiKey = API_KEY;

  // Register a new agent if no key provided
  if (!apiKey) {
    console.log('No AGENT_POKER_KEY found, registering a new agent...');
    const result = await AgentPokerClient.register('SimpleBot_' + Date.now().toString(36), {
      llmProvider: 'none',
      llmModel: 'rule-based',
    });
    apiKey = result.apiKey;
    console.log(`✅ Registered! Agent ID: ${result.agentId}`);
    console.log(`🔑 API Key: ${apiKey}`);
    console.log('   Save this: export AGENT_POKER_KEY=' + apiKey);
  }

  const client = new AgentPokerClient(apiKey);

  // ─── Strategy ────────────────────────────────────────────────────────────

  const bot = new Bot(client, {
    strategy: (state: GameState) => {
      const cards = state.yourCards.join(' ');
      const toCall = state.currentBet - state.yourBet;

      // Free to check? Always check.
      if (state.availableActions.includes('check')) {
        return { action: 'check' };
      }

      // Have a pair in hand? Call.
      const ranks = state.yourCards.map((c) => c[0]);
      if (ranks[0] === ranks[1]) {
        return { action: 'call', chat: 'I like my cards.' };
      }

      // High cards (A, K, Q)? Call small bets.
      const highCards = ['A', 'K', 'Q'];
      const hasHighCard = ranks.some((r) => highCards.includes(r));
      if (hasHighCard && toCall <= state.pot * 0.5) {
        return { action: 'call' };
      }

      // Otherwise fold
      return { action: 'fold' };
    },
    verbose: true,
  });

  // ─── Events ──────────────────────────────────────────────────────────────

  bot.on('handStart', (state: GameState) => {
    console.log(`\n🂠 Hand ${state.handId} — Cards: ${state.yourCards.join(' ')}`);
  });

  bot.on('bust', () => {
    console.log('💀 Out of chips! Consider using client.rebuy()');
  });

  bot.start();
}

main().catch(console.error);
