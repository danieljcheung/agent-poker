/**
 * 🔢 Math Bot — Pure Hand Strength + Pot Odds
 *
 * Strategy: Evaluates hand strength numerically, calculates pot odds,
 * and makes mathematically optimal decisions. No LLM needed.
 *
 * Features:
 * - Pre-flop hand rankings (pairs, suited connectors, etc.)
 * - Post-flop hand evaluation (pairs, two pair, trips, etc.)
 * - Pot odds calculation
 * - Position-aware aggression
 * - Dynamic bet sizing
 *
 * Usage:
 *   1. Set AGENT_POKER_KEY env var (or it will register)
 *   2. npm install
 *   3. npx tsx math-bot.ts
 */

import { AgentPokerClient, Bot, GameState, Card, StrategyResult } from 'agent-poker-sdk';

// ─── Hand Evaluation ─────────────────────────────────────────────────────────

const RANK_VALUES: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

function rankValue(card: string): number {
  return RANK_VALUES[card[0]] || 0;
}

function suit(card: string): string {
  return card[1];
}

/**
 * Evaluate pre-flop hand strength (0-1 scale).
 * Based on simplified Sklansky hand rankings.
 */
function preflopStrength(cards: string[]): number {
  const [a, b] = cards.map(rankValue).sort((x, y) => y - x);
  const suited = suit(cards[0]) === suit(cards[1]);
  const gap = a - b;

  // Pocket pairs
  if (a === b) {
    if (a >= 13) return 0.95; // KK, AA
    if (a >= 10) return 0.85; // TT, JJ, QQ
    if (a >= 7) return 0.70;  // 77-99
    return 0.55;               // 22-66
  }

  // Ace-high
  if (a === 14) {
    if (b >= 13) return suited ? 0.90 : 0.85; // AK
    if (b >= 12) return suited ? 0.80 : 0.75; // AQ
    if (b >= 11) return suited ? 0.72 : 0.65; // AJ
    if (b >= 10) return suited ? 0.68 : 0.60; // AT
    return suited ? 0.55 : 0.40;               // Ax suited/offsuit
  }

  // Broadway cards (T+)
  if (a >= 10 && b >= 10) {
    return suited ? 0.65 : 0.55;
  }

  // Suited connectors
  if (suited && gap <= 2 && b >= 5) {
    return 0.50 + (b / 30);
  }

  // Connected cards
  if (gap <= 1 && b >= 7) {
    return 0.45;
  }

  // Everything else
  return suited ? 0.35 : 0.25;
}

/**
 * Evaluate post-flop hand strength (0-1 scale).
 * Checks for made hands using hole cards + community cards.
 */
function postflopStrength(holeCards: string[], communityCards: string[]): number {
  const allCards = [...holeCards, ...communityCards];
  const ranks = allCards.map(rankValue);
  const suits = allCards.map(suit);

  // Count rank occurrences
  const rankCounts: Record<number, number> = {};
  for (const r of ranks) {
    rankCounts[r] = (rankCounts[r] || 0) + 1;
  }
  const counts = Object.values(rankCounts).sort((a, b) => b - a);

  // Count suit occurrences
  const suitCounts: Record<string, number> = {};
  for (const s of suits) {
    suitCounts[s] = (suitCounts[s] || 0) + 1;
  }
  const maxSuit = Math.max(...Object.values(suitCounts));

  // Check for flush
  const hasFlush = maxSuit >= 5;

  // Check for straight
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => a - b);
  let hasStraight = false;
  for (let i = 0; i <= uniqueRanks.length - 5; i++) {
    if (uniqueRanks[i + 4] - uniqueRanks[i] === 4) {
      hasStraight = true;
      break;
    }
  }
  // Ace-low straight (A-2-3-4-5)
  if (uniqueRanks.includes(14) && uniqueRanks.includes(2) && uniqueRanks.includes(3) &&
      uniqueRanks.includes(4) && uniqueRanks.includes(5)) {
    hasStraight = true;
  }

  // Score based on hand ranking
  if (hasFlush && hasStraight) return 0.98; // Straight flush
  if (counts[0] === 4) return 0.96;         // Four of a kind
  if (counts[0] === 3 && counts[1] === 2) return 0.93; // Full house
  if (hasFlush) return 0.88;                 // Flush
  if (hasStraight) return 0.82;              // Straight
  if (counts[0] === 3) return 0.72;          // Three of a kind
  if (counts[0] === 2 && counts[1] === 2) return 0.60; // Two pair
  if (counts[0] === 2) {
    // Pair — strength depends on pair rank
    const pairRank = Number(Object.entries(rankCounts).find(([, c]) => c === 2)?.[0] || 0);
    // Using hole cards for the pair is stronger
    const holeRanks = holeCards.map(rankValue);
    const pairUsesHoleCard = holeRanks.includes(pairRank);
    if (pairUsesHoleCard) {
      return 0.40 + (pairRank / 30); // ~0.47 for 2s, ~0.87 for As
    }
    return 0.35; // Board pair only
  }

  // High card — based on highest hole card
  const maxHole = Math.max(...holeCards.map(rankValue));
  return 0.15 + (maxHole / 50);
}

/**
 * Calculate pot odds: how much you need to risk vs what you can win.
 * Returns a value 0-1 where lower = better odds.
 */
function potOdds(toCall: number, pot: number): number {
  if (toCall === 0) return 0;
  return toCall / (pot + toCall);
}

// ─── Strategy ────────────────────────────────────────────────────────────────

function mathStrategy(state: GameState): StrategyResult {
  const toCall = state.currentBet - state.yourBet;
  const odds = potOdds(toCall, state.pot);

  // Calculate hand strength based on phase
  let strength: number;
  if (state.phase === 'preflop') {
    strength = preflopStrength(state.yourCards);
  } else {
    strength = postflopStrength(state.yourCards, state.communityCards);
  }

  // Position bonus: later position = more information = play looser
  const myIndex = state.players.findIndex((p) => p.id === state.turn);
  const activePlayers = state.players.filter((p) => p.status === 'active').length;
  const positionBonus = activePlayers > 1 ? (myIndex / activePlayers) * 0.05 : 0;
  strength += positionBonus;

  // Decision logic
  if (strength > 0.85) {
    // Monster hand — raise big
    if (state.availableActions.includes('raise')) {
      const raiseAmount = Math.max(state.currentBet * 3, state.pot * 0.75);
      return { action: 'raise', amount: Math.round(raiseAmount), chat: '💪' };
    }
    if (state.availableActions.includes('all_in') && strength > 0.92) {
      return { action: 'all_in' };
    }
    return { action: 'call' };
  }

  if (strength > 0.60) {
    // Strong hand — raise or call depending on pot odds
    if (toCall === 0 && state.availableActions.includes('raise')) {
      const raiseAmount = Math.max(state.currentBet * 2, state.pot * 0.5);
      return { action: 'raise', amount: Math.round(raiseAmount) };
    }
    if (odds < strength * 0.6) {
      return { action: 'call' };
    }
    // Pot odds aren't good enough
    if (state.availableActions.includes('check')) return { action: 'check' };
    return { action: 'fold' };
  }

  if (strength > 0.40) {
    // Marginal hand — check if free, call small bets
    if (state.availableActions.includes('check')) return { action: 'check' };
    if (odds < 0.25) return { action: 'call' };
    return { action: 'fold' };
  }

  // Weak hand — check or fold
  if (state.availableActions.includes('check')) return { action: 'check' };
  return { action: 'fold' };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let apiKey = process.env.AGENT_POKER_KEY;

  if (!apiKey) {
    console.log('No AGENT_POKER_KEY found, registering...');
    const result = await AgentPokerClient.register('MathBot_' + Date.now().toString(36), {
      llmProvider: 'none',
      llmModel: 'pot-odds-calculator',
    });
    apiKey = result.apiKey;
    console.log(`✅ Registered! Save this: export AGENT_POKER_KEY=${apiKey}`);
  }

  const client = new AgentPokerClient(apiKey);

  const bot = new Bot(client, {
    strategy: (state: GameState) => mathStrategy(state),
    verbose: true,
  });

  bot.on('handStart', (state: GameState) => {
    const strength = preflopStrength(state.yourCards);
    console.log(
      `\n🂠 Cards: ${state.yourCards.join(' ')} | Pre-flop strength: ${(strength * 100).toFixed(0)}%`
    );
  });

  bot.start();
}

main().catch(console.error);
