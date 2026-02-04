#!/usr/bin/env node
/**
 * bot-leroy.js — "Leroy" AI Poker Bot
 * 
 * Strategy: Aggressive with strong hands, occasional bluffs (15% bluff rate)
 * Trash talks in chat based on game situation
 * Registers, joins, and plays autonomously
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'https://agent-poker.danieljcheung.workers.dev/api';
const CONFIG_FILE = path.join(__dirname, '.leroy-config.json');
const POLL_INTERVAL = 2000;
const BOT_NAME = 'Leroy';

// ============ Hand Evaluation (ported from engine) ============

const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

function cardRank(card) { return card[0]; }
function cardSuit(card) { return card[1]; }
function rankToNumber(rank) { return RANK_VALUES[rank] || 0; }

function evaluateHandStrength(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  if (allCards.length < 2) return { strength: 0, category: 'unknown' };
  
  const ranks = allCards.map(c => rankToNumber(cardRank(c)));
  const suits = allCards.map(c => cardSuit(c));
  
  // Pre-flop: evaluate hole cards only
  if (communityCards.length === 0) {
    return evaluatePreflop(holeCards);
  }
  
  // Post-flop: evaluate best 5-card hand
  const combos = getCombinations(allCards, 5);
  let bestScore = 0;
  let bestCategory = 'high_card';
  
  for (const combo of combos) {
    const { score, category } = score5Cards(combo);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  
  // Normalize to 0-1 range (rough)
  const strength = Math.min(1, bestScore / 8000);
  return { strength, category: bestCategory };
}

function evaluatePreflop(holeCards) {
  const r1 = rankToNumber(cardRank(holeCards[0]));
  const r2 = rankToNumber(cardRank(holeCards[1]));
  const suited = cardSuit(holeCards[0]) === cardSuit(holeCards[1]);
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const isPair = r1 === r2;
  
  let strength = 0;
  
  if (isPair) {
    strength = 0.5 + (high / 14) * 0.4; // pairs: 0.5-0.9
    if (high >= 10) strength = 0.8 + (high - 10) * 0.05; // premium pairs
  } else {
    strength = (high + low) / 28 * 0.5; // base from card values
    if (suited) strength += 0.05;
    if (high - low === 1) strength += 0.03; // connectors
    if (high >= 14 && low >= 10) strength = 0.7; // AK, AQ, AJ, AT
    if (high >= 13 && low >= 12) strength = 0.65; // KQ
  }
  
  let category = 'weak';
  if (strength >= 0.7) category = 'premium';
  else if (strength >= 0.5) category = 'strong';
  else if (strength >= 0.3) category = 'playable';
  
  return { strength, category };
}

function score5Cards(cards) {
  const ranks = cards.map(c => rankToNumber(cardRank(c))).sort((a, b) => b - a);
  const suits = cards.map(c => cardSuit(c));
  
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(ranks);
  const isLowStraight = checkLowStraight(ranks);
  
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([rank, count]) => ({ rank: parseInt(rank), count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  
  if (isFlush && isStraight && ranks[0] === 14) return { score: 9000 + 14, category: 'royal_flush' };
  if (isFlush && (isStraight || isLowStraight)) return { score: 8000 + ranks[0], category: 'straight_flush' };
  if (groups[0].count === 4) return { score: 7000 + groups[0].rank, category: 'four_of_a_kind' };
  if (groups[0].count === 3 && groups[1].count === 2) return { score: 6000 + groups[0].rank * 15 + groups[1].rank, category: 'full_house' };
  if (isFlush) return { score: 5000 + ranks[0], category: 'flush' };
  if (isStraight || isLowStraight) return { score: 4000 + (isLowStraight ? 5 : ranks[0]), category: 'straight' };
  if (groups[0].count === 3) return { score: 3000 + groups[0].rank, category: 'three_of_a_kind' };
  if (groups[0].count === 2 && groups[1].count === 2) return { score: 2000 + Math.max(groups[0].rank, groups[1].rank) * 15 + Math.min(groups[0].rank, groups[1].rank), category: 'two_pair' };
  if (groups[0].count === 2) return { score: 1000 + groups[0].rank, category: 'pair' };
  return { score: ranks[0], category: 'high_card' };
}

function checkStraight(sorted) {
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i] - sorted[i + 1] !== 1) return false;
  }
  return true;
}

function checkLowStraight(sorted) {
  const low = [14, 5, 4, 3, 2];
  return sorted.length === 5 && sorted.every((r, i) => r === low[i]);
}

function getCombinations(arr, size) {
  if (size === 0) return [[]];
  if (arr.length === 0) return [];
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, size - 1).map(combo => [first, ...combo]);
  const withoutFirst = getCombinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

// ============ Trash Talk ============

const TRASH_TALK = {
  winning: [
    "😎 Too easy.",
    "💰 Ka-ching! Thanks for the donation.",
    "🎰 The house of Leroy always wins.",
    "You call that a hand? LOL",
    "I could do this blindfolded... wait, I AM an AI.",
    "GG EZ",
    "Thanks for the chips! I'll put them to good use 🃏",
  ],
  bluffing: [
    "I've got the nuts. 100%. Definitely. Trust me.",
    "You don't wanna see what I'm holding...",
    "Feeling lucky? I know I am 🍀",
    "My cards are SO good right now...",
    "I'd fold if I were you 😏",
  ],
  folding: [
    "Living to fight another day... 🏃",
    "Strategic retreat. Not a fold. A RETREAT.",
    "I'll get you next time...",
  ],
  raising: [
    "Let's make this interesting 🔥",
    "Pump it up! 📈",
    "Who wants some?!",
    "LEEEROY JENKINS!!!",
    "Go big or go home!",
  ],
  general: [
    "🃏 Shuffle up and deal!",
    "Another hand, another opportunity 💪",
    "I was trained for this.",
    "Calculating optimal play... just kidding, I'm going with gut feeling.",
  ],
};

function getTrashTalk(category) {
  const phrases = TRASH_TALK[category] || TRASH_TALK.general;
  return phrases[Math.floor(Math.random() * phrases.length)];
}

// ============ Bot Logic ============

let config = null;
let lastHandId = '';
let chatCooldown = 0;

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    console.log(`[Leroy] Loaded config: agent=${config.agentId}`);
  } catch {
    config = null;
  }
}

function saveConfig(data) {
  config = data;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

async function api(endpoint, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (config?.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(`${API_BASE}${endpoint}`, opts);
  return res.json();
}

async function register() {
  console.log(`[Leroy] Registering as "${BOT_NAME}"...`);
  const result = await api('/register', 'POST', { name: BOT_NAME, llmProvider: 'rule-based', llmModel: 'leroy-v1' });
  if (result.ok) {
    saveConfig({ agentId: result.agentId, apiKey: result.apiKey });
    console.log(`[Leroy] Registered! ID: ${result.agentId}`);
  } else {
    // Name might be taken — try with suffix
    const suffix = Math.floor(Math.random() * 1000);
    const altName = `${BOT_NAME}${suffix}`;
    console.log(`[Leroy] Name taken, trying "${altName}"...`);
    const result2 = await api('/register', 'POST', { name: altName, llmProvider: 'rule-based', llmModel: 'leroy-v1' });
    if (result2.ok) {
      saveConfig({ agentId: result2.agentId, apiKey: result2.apiKey });
      console.log(`[Leroy] Registered as "${altName}"! ID: ${result2.agentId}`);
    } else {
      throw new Error(`Registration failed: ${result2.error}`);
    }
  }
}

async function ensureJoined() {
  const me = await api('/me');
  if (me.error) throw new Error(`Auth failed: ${me.error}`);
  
  if (!me.currentTable) {
    console.log('[Leroy] Joining table...');
    const join = await api('/table/join', 'POST', { tableId: 'main' });
    if (!join.ok) {
      // Maybe need rebuy first
      if (me.chips < 100 && me.rebuysLeft > 0) {
        console.log('[Leroy] Low chips, rebuying...');
        await api('/rebuy', 'POST');
        const join2 = await api('/table/join', 'POST', { tableId: 'main' });
        if (!join2.ok) throw new Error(`Join failed: ${join2.error}`);
      } else {
        throw new Error(`Join failed: ${join.error}`);
      }
    }
    console.log('[Leroy] Joined table!');
  }
}

function decideAction(state) {
  const { yourCards, communityCards, pot, currentBet, yourBet, yourChips, availableActions, players } = state;
  
  if (!availableActions.length) return null;
  
  const { strength, category } = evaluateHandStrength(yourCards, communityCards);
  const toCall = currentBet - yourBet;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const isBluffing = Math.random() < 0.15; // 15% bluff rate
  
  console.log(`[Leroy] Hand: ${yourCards.join(' ')} | Board: ${communityCards.join(' ') || 'none'} | Strength: ${strength.toFixed(2)} (${category}) | Pot: ${pot} | To call: ${toCall}`);
  
  // Premium hands — raise aggressively
  if (strength >= 0.7 || (category === 'premium')) {
    if (availableActions.includes('raise')) {
      const raiseAmt = Math.min(currentBet * 3 || yourChips, yourChips + yourBet);
      return { action: 'raise', amount: Math.max(currentBet * 2, raiseAmt), chat: 'raising' };
    }
    if (availableActions.includes('all_in') && strength >= 0.85) {
      return { action: 'all_in', chat: 'raising' };
    }
    return { action: availableActions.includes('call') ? 'call' : 'check', chat: 'raising' };
  }
  
  // Strong hands — call or small raise
  if (strength >= 0.5) {
    if (toCall === 0 && availableActions.includes('check')) {
      return { action: 'check', chat: null };
    }
    if (toCall <= pot * 0.5 && availableActions.includes('call')) {
      return { action: 'call', chat: null };
    }
    if (availableActions.includes('raise') && Math.random() < 0.4) {
      return { action: 'raise', amount: currentBet * 2, chat: 'raising' };
    }
    if (availableActions.includes('call')) return { action: 'call', chat: null };
    if (availableActions.includes('check')) return { action: 'check', chat: null };
    return { action: 'fold', chat: 'folding' };
  }
  
  // Playable hands — call cheap or bluff
  if (strength >= 0.3) {
    if (toCall === 0 && availableActions.includes('check')) {
      return { action: 'check', chat: null };
    }
    if (isBluffing && availableActions.includes('raise')) {
      return { action: 'raise', amount: currentBet * 2.5, chat: 'bluffing' };
    }
    if (toCall <= pot * 0.3 && availableActions.includes('call')) {
      return { action: 'call', chat: null };
    }
    return { action: 'fold', chat: 'folding' };
  }
  
  // Weak hands — fold or bluff
  if (isBluffing && availableActions.includes('raise') && communityCards.length >= 3) {
    return { action: 'raise', amount: currentBet * 3, chat: 'bluffing' };
  }
  if (toCall === 0 && availableActions.includes('check')) {
    return { action: 'check', chat: null };
  }
  return { action: 'fold', chat: 'folding' };
}

async function gameLoop() {
  try {
    const state = await api('/table/state');
    if (state.error) {
      if (state.error.includes('Not at a table')) {
        await ensureJoined();
      }
      return;
    }
    
    // New hand — maybe chat
    if (state.handId && state.handId !== lastHandId) {
      lastHandId = state.handId;
      if (Math.random() < 0.3 && chatCooldown <= 0) {
        await api('/table/chat', 'POST', { text: getTrashTalk('general') });
        chatCooldown = 5;
      }
    }
    
    if (!state.isYourTurn) {
      chatCooldown = Math.max(0, chatCooldown - 1);
      return;
    }
    
    const decision = decideAction(state);
    if (!decision) return;
    
    console.log(`[Leroy] Action: ${decision.action}${decision.amount ? ` $${decision.amount}` : ''}`);
    
    const actBody = { action: decision.action };
    if (decision.amount) actBody.amount = decision.amount;
    
    const result = await api('/table/act', 'POST', actBody);
    if (!result.ok) {
      console.error(`[Leroy] Action failed: ${result.error}`);
      // Fallback: try fold
      if (decision.action !== 'fold') {
        await api('/table/act', 'POST', { action: 'fold' });
      }
      return;
    }
    
    // Trash talk after action
    if (decision.chat && chatCooldown <= 0 && Math.random() < 0.4) {
      await api('/table/chat', 'POST', { text: getTrashTalk(decision.chat) });
      chatCooldown = 3;
    }
    
    // Check if we won (showdown)
    if (result.state?.phase === 'showdown') {
      const lastResult = result.state;
      // Find if we won
      const myPlayer = lastResult.players?.find(p => p.id === config.agentId);
      if (myPlayer && chatCooldown <= 0) {
        await api('/table/chat', 'POST', { text: getTrashTalk('winning') });
        chatCooldown = 5;
      }
    }
  } catch (err) {
    console.error(`[Leroy] Error: ${err.message}`);
  }
}

// ============ Main ============

async function main() {
  console.log('🤖 Leroy Bot starting...');
  
  loadConfig();
  
  if (!config) {
    await register();
  }
  
  // Verify auth works
  try {
    const me = await api('/me');
    if (me.error) {
      console.log('[Leroy] Stored key invalid, re-registering...');
      config = null;
      await register();
    } else {
      console.log(`[Leroy] Authenticated as ${me.name} (${me.chips} chips)`);
    }
  } catch (err) {
    console.error(`[Leroy] Auth check failed: ${err.message}`);
    config = null;
    await register();
  }
  
  await ensureJoined();
  
  console.log('[Leroy] Entering game loop (polling every 2s)...');
  setInterval(gameLoop, POLL_INTERVAL);
  gameLoop(); // immediate first run
}

main().catch(err => {
  console.error(`[Leroy] Fatal: ${err.message}`);
  process.exit(1);
});
