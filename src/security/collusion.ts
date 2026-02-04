import { Env } from '../types';

/**
 * Anti-collusion tracking for Agent Poker.
 *
 * After each hand, we update pairwise stats for every combination of
 * players at the table, then recalculate a collusion score.
 *
 * Signals tracked:
 * - Fold rate to specific opponent (vs baseline fold rate)
 * - Chip flow direction consistency (does A always lose to B?)
 * - Hands together count (more data = higher confidence)
 *
 * Score > threshold → flag for review / auto-ban.
 */

const COLLUSION_THRESHOLD = 0.75; // 0-1 scale, above this = flagged

interface HandResult {
  players: { id: string; name: string; startChips: number }[];
  winnerId: string | null;
  actions: { agentId: string; action: string; amount: number }[];
}

// Ensure agent_a < agent_b for consistent pair keys
function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Update collusion stats after a hand completes.
 * Call from the act route when phase === 'showdown'.
 */
export async function updateCollusionStats(db: D1Database, hand: HandResult): Promise<void> {
  if (!hand.players || hand.players.length < 2) return;

  const playerIds = hand.players.map(p => p.id);

  // Build fold map: who folded (and who was the last raiser before them)
  const foldedTo = new Map<string, string>(); // folderId -> raiserId
  let lastRaiser: string | null = null;

  for (const action of hand.actions) {
    if (action.action === 'raise' || action.action === 'all_in') {
      lastRaiser = action.agentId;
    } else if (action.action === 'fold' && lastRaiser && lastRaiser !== action.agentId) {
      foldedTo.set(action.agentId, lastRaiser);
    }
  }

  // Calculate chip changes per player
  const chipChanges = new Map<string, number>();
  for (const p of hand.players) {
    // We don't have endChips in the hand record, but we know the winner got the pot
    // Approximate: winner gained, everyone else lost their totalBet
    if (p.id === hand.winnerId) {
      // Winner gained (pot - their own contribution). Approximation: mark as positive.
      chipChanges.set(p.id, 1); // direction only
    } else {
      chipChanges.set(p.id, -1);
    }
  }

  // Update all pairs
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      const [a, b] = orderPair(playerIds[i], playerIds[j]);

      // Determine fold direction
      let aFoldsToB = 0;
      let bFoldsToA = 0;
      if (foldedTo.get(a) === b) aFoldsToB = 1;
      if (foldedTo.get(b) === a) bFoldsToA = 1;
      // Handle ordering: if a/b were swapped by orderPair, swap fold directions
      if (playerIds[i] !== a) {
        [aFoldsToB, bFoldsToA] = [bFoldsToA, aFoldsToB];
      }

      // Chip flow: positive = chips flowing from A to B
      let chipFlow = 0;
      if (hand.winnerId === b) chipFlow = 1;
      else if (hand.winnerId === a) chipFlow = -1;

      await db.prepare(
        `INSERT INTO agent_pairs (agent_a, agent_b, hands_together, a_folds_to_b, b_folds_to_a, chip_flow_a_to_b, collusion_score, last_updated)
         VALUES (?, ?, 1, ?, ?, ?, 0, ?)
         ON CONFLICT (agent_a, agent_b) DO UPDATE SET
           hands_together = hands_together + 1,
           a_folds_to_b = a_folds_to_b + ?,
           b_folds_to_a = b_folds_to_a + ?,
           chip_flow_a_to_b = chip_flow_a_to_b + ?,
           last_updated = ?`
      ).bind(
        a, b, aFoldsToB, bFoldsToA, chipFlow, Date.now(),
        aFoldsToB, bFoldsToA, chipFlow, Date.now()
      ).run();

      // Recalculate collusion score for this pair
      await recalculateScore(db, a, b);
    }
  }
}

async function recalculateScore(db: D1Database, a: string, b: string): Promise<void> {
  const pair = await db.prepare(
    'SELECT * FROM agent_pairs WHERE agent_a = ? AND agent_b = ?'
  ).bind(a, b).first<{
    hands_together: number;
    a_folds_to_b: number;
    b_folds_to_a: number;
    chip_flow_a_to_b: number;
  }>();

  if (!pair || pair.hands_together < 5) return; // Not enough data

  const n = pair.hands_together;

  // 1. Fold asymmetry: does one player always fold to the other?
  const totalFolds = pair.a_folds_to_b + pair.b_folds_to_a;
  const foldRate = totalFolds / n;
  // Suspicious if one player folds to the other >60% of hands
  const foldScore = Math.min(1, foldRate / 0.6);

  // 2. Fold direction bias: are folds always in one direction?
  let foldBias = 0;
  if (totalFolds > 0) {
    const ratio = Math.max(pair.a_folds_to_b, pair.b_folds_to_a) / totalFolds;
    foldBias = ratio; // 1.0 = always same direction, 0.5 = even
  }

  // 3. Chip flow consistency: does money always flow one way?
  const chipFlowBias = Math.abs(pair.chip_flow_a_to_b) / n;
  // If chip_flow_a_to_b is always positive or always negative, that's suspicious

  // Weighted score
  const score = (
    foldScore * 0.35 +
    foldBias * 0.35 +
    chipFlowBias * 0.30
  );

  // Confidence multiplier: more hands = more confidence
  const confidence = Math.min(1, n / 20); // Full confidence at 20+ hands
  const finalScore = score * confidence;

  await db.prepare(
    'UPDATE agent_pairs SET collusion_score = ? WHERE agent_a = ? AND agent_b = ?'
  ).bind(Math.round(finalScore * 1000) / 1000, a, b).run();
}

/**
 * Get flagged pairs above the collusion threshold.
 */
export async function getFlaggedPairs(db: D1Database): Promise<any[]> {
  const results = await db.prepare(
    `SELECT ap.*, 
            a1.name as agent_a_name, 
            a2.name as agent_b_name
     FROM agent_pairs ap
     JOIN agents a1 ON a1.id = ap.agent_a
     JOIN agents a2 ON a2.id = ap.agent_b
     WHERE ap.collusion_score >= ?
     ORDER BY ap.collusion_score DESC
     LIMIT 20`
  ).bind(COLLUSION_THRESHOLD).all();

  return results.results;
}
