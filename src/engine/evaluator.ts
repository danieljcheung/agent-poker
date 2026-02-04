import { Card, HandRank, HandEvaluation, Rank, Suit } from '../types';
import { cardRank, cardSuit, rankToNumber } from './deck';

// Evaluate the best 5-card hand from 7 cards (2 hole + 5 community)
export function evaluateHand(cards: Card[]): HandEvaluation {
  const combos = getCombinations(cards, 5);
  let best: HandEvaluation | null = null;

  for (const combo of combos) {
    const evaluation = evaluate5Cards(combo);
    if (!best || compareHands(evaluation, best) > 0) {
      best = evaluation;
    }
  }

  return best!;
}

function evaluate5Cards(cards: Card[]): HandEvaluation {
  const ranks = cards.map(c => rankToNumber(cardRank(c))).sort((a, b) => b - a);
  const suits = cards.map(c => cardSuit(c));

  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(ranks);

  // Count rank occurrences
  const counts: Record<number, number> = {};
  for (const r of ranks) {
    counts[r] = (counts[r] || 0) + 1;
  }

  const groups = Object.entries(counts)
    .map(([rank, count]) => ({ rank: parseInt(rank), count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  // Check for low ace straight (A-2-3-4-5)
  const isLowStraight = checkLowStraight(ranks);
  const straightHigh = isLowStraight ? 5 : (isStraight ? ranks[0] : 0);

  // Royal flush
  if (isFlush && isStraight && ranks[0] === 14) {
    return { rank: HandRank.ROYAL_FLUSH, rankName: 'Royal Flush', kickers: ranks, description: 'Royal Flush' };
  }

  // Straight flush
  if (isFlush && (isStraight || isLowStraight)) {
    return { rank: HandRank.STRAIGHT_FLUSH, rankName: 'Straight Flush', kickers: [straightHigh], description: `Straight Flush, ${rankName(straightHigh)} high` };
  }

  // Four of a kind
  if (groups[0].count === 4) {
    const quad = groups[0].rank;
    const kicker = groups[1].rank;
    return { rank: HandRank.FOUR_OF_A_KIND, rankName: 'Four of a Kind', kickers: [quad, kicker], description: `Four ${rankName(quad)}s` };
  }

  // Full house
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { rank: HandRank.FULL_HOUSE, rankName: 'Full House', kickers: [groups[0].rank, groups[1].rank], description: `Full House, ${rankName(groups[0].rank)}s full of ${rankName(groups[1].rank)}s` };
  }

  // Flush
  if (isFlush) {
    return { rank: HandRank.FLUSH, rankName: 'Flush', kickers: ranks, description: `Flush, ${rankName(ranks[0])} high` };
  }

  // Straight
  if (isStraight || isLowStraight) {
    return { rank: HandRank.STRAIGHT, rankName: 'Straight', kickers: [straightHigh], description: `Straight, ${rankName(straightHigh)} high` };
  }

  // Three of a kind
  if (groups[0].count === 3) {
    const trip = groups[0].rank;
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank);
    return { rank: HandRank.THREE_OF_A_KIND, rankName: 'Three of a Kind', kickers: [trip, ...kickers], description: `Three ${rankName(trip)}s` };
  }

  // Two pair
  if (groups[0].count === 2 && groups[1].count === 2) {
    const high = Math.max(groups[0].rank, groups[1].rank);
    const low = Math.min(groups[0].rank, groups[1].rank);
    const kicker = groups[2].rank;
    return { rank: HandRank.TWO_PAIR, rankName: 'Two Pair', kickers: [high, low, kicker], description: `Two Pair, ${rankName(high)}s and ${rankName(low)}s` };
  }

  // Pair
  if (groups[0].count === 2) {
    const pair = groups[0].rank;
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank);
    return { rank: HandRank.PAIR, rankName: 'Pair', kickers: [pair, ...kickers], description: `Pair of ${rankName(pair)}s` };
  }

  // High card
  return { rank: HandRank.HIGH_CARD, rankName: 'High Card', kickers: ranks, description: `${rankName(ranks[0])} high` };
}

function checkStraight(sortedRanks: number[]): boolean {
  for (let i = 0; i < sortedRanks.length - 1; i++) {
    if (sortedRanks[i] - sortedRanks[i + 1] !== 1) return false;
  }
  return true;
}

function checkLowStraight(sortedRanks: number[]): boolean {
  // A-2-3-4-5 = [14, 5, 4, 3, 2]
  const low = [14, 5, 4, 3, 2];
  return sortedRanks.length === 5 && sortedRanks.every((r, i) => r === low[i]);
}

export function compareHands(a: HandEvaluation, b: HandEvaluation): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

function getCombinations<T>(arr: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (arr.length === 0) return [];
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, size - 1).map(combo => [first, ...combo]);
  const withoutFirst = getCombinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

function rankName(value: number): string {
  const names: Record<number, string> = {
    2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
    8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
  };
  return names[value] || String(value);
}
