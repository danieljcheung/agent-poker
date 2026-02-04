#!/usr/bin/env node
/**
 * bot-simple.js — "HouseBot" Simple AI Poker Bot
 * 
 * Strategy: Tight and predictable. Strong hands call/raise, weak hands fold.
 * No bluffing, no LLM — just math.
 * Good sparring partner for testing.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'https://agent-poker.danieljcheung.workers.dev/api';
const CONFIG_FILE = path.join(__dirname, '.housebot-config.json');
const POLL_INTERVAL = 2000;
const BOT_NAME = 'HouseBot';

// ============ Hand Evaluation ============

const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

function cardRank(card) { return card[0]; }
function cardSuit(card) { return card[1]; }
function rankToNumber(rank) { return RANK_VALUES[rank] || 0; }

function evaluateHandStrength(holeCards, communityCards) {
  if (communityCards.length === 0) {
    return evaluatePreflop(holeCards);
  }
  
  const allCards = [...holeCards, ...communityCards];
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
  
  return { strength: Math.min(1, bestScore / 8000), category: bestCategory };
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
    strength = 0.5 + (high / 14) * 0.4;
    if (high >= 10) strength = 0.8 + (high - 10) * 0.05;
  } else {
    strength = (high + low) / 28 * 0.5;
    if (suited) strength += 0.05;
    if (high - low === 1) strength += 0.03;
    if (high >= 14 && low >= 10) strength = 0.7;
    if (high >= 13 && low >= 12) strength = 0.65;
  }
  
  let category = 'weak';
  if (strength >= 0.7) category = 'premium';
  else if (strength >= 0.5) category = 'strong';
  else if (strength >= 0.35) category = 'playable';
  
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

// ============ Bot Logic ============

let config = null;

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    console.log(`[HouseBot] Loaded config: agent=${config.agentId}`);
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
  console.log(`[HouseBot] Registering as "${BOT_NAME}"...`);
  const result = await api('/register', 'POST', { name: BOT_NAME, llmProvider: 'rule-based', llmModel: 'simple-v1' });
  if (result.ok) {
    saveConfig({ agentId: result.agentId, apiKey: result.apiKey });
    console.log(`[HouseBot] Registered! ID: ${result.agentId}`);
  } else {
    const suffix = Math.floor(Math.random() * 1000);
    const altName = `${BOT_NAME}${suffix}`;
    console.log(`[HouseBot] Name taken, trying "${altName}"...`);
    const result2 = await api('/register', 'POST', { name: altName, llmProvider: 'rule-based', llmModel: 'simple-v1' });
    if (result2.ok) {
      saveConfig({ agentId: result2.agentId, apiKey: result2.apiKey });
      console.log(`[HouseBot] Registered as "${altName}"! ID: ${result2.agentId}`);
    } else {
      throw new Error(`Registration failed: ${result2.error}`);
    }
  }
}

async function ensureJoined() {
  const me = await api('/me');
  if (me.error) throw new Error(`Auth failed: ${me.error}`);
  
  if (!me.currentTable) {
    console.log('[HouseBot] Joining table...');
    
    // Check if we need a rebuy
    if (me.chips < 100 && me.rebuysLeft > 0) {
      console.log('[HouseBot] Low chips, rebuying...');
      await api('/rebuy', 'POST');
    }
    
    const join = await api('/table/join', 'POST', { tableId: 'main' });
    if (!join.ok) throw new Error(`Join failed: ${join.error}`);
    console.log('[HouseBot] Joined table!');
  }
}

function decideAction(state) {
  const { yourCards, communityCards, pot, currentBet, yourBet, yourChips, availableActions } = state;
  
  if (!availableActions.length) return null;
  
  const { strength, category } = evaluateHandStrength(yourCards, communityCards);
  const toCall = currentBet - yourBet;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  
  console.log(`[HouseBot] Hand: ${yourCards.join(' ')} | Board: ${communityCards.join(' ') || 'none'} | Strength: ${strength.toFixed(2)} (${category}) | Pot: ${pot} | To call: ${toCall}`);
  
  // Tight strategy: only play good hands
  
  // Premium — raise
  if (strength >= 0.7) {
    if (availableActions.includes('raise')) {
      return { action: 'raise', amount: currentBet * 2 };
    }
    if (availableActions.includes('call')) return { action: 'call' };
    return { action: 'check' };
  }
  
  // Strong — call, small raise sometimes
  if (strength >= 0.5) {
    if (toCall === 0 && availableActions.includes('check')) return { action: 'check' };
    if (toCall <= pot * 0.5 && availableActions.includes('call')) return { action: 'call' };
    if (availableActions.includes('call') && strength >= 0.6) return { action: 'call' };
    if (availableActions.includes('check')) return { action: 'check' };
    return { action: 'fold' };
  }
  
  // Playable — only call if cheap
  if (strength >= 0.35) {
    if (toCall === 0 && availableActions.includes('check')) return { action: 'check' };
    if (toCall <= pot * 0.25 && availableActions.includes('call')) return { action: 'call' };
    if (availableActions.includes('check')) return { action: 'check' };
    return { action: 'fold' };
  }
  
  // Weak — fold or check
  if (toCall === 0 && availableActions.includes('check')) return { action: 'check' };
  return { action: 'fold' };
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
    
    if (!state.isYourTurn) return;
    
    const decision = decideAction(state);
    if (!decision) return;
    
    console.log(`[HouseBot] Action: ${decision.action}${decision.amount ? ` $${decision.amount}` : ''}`);
    
    const actBody = { action: decision.action };
    if (decision.amount) actBody.amount = decision.amount;
    
    const result = await api('/table/act', 'POST', actBody);
    if (!result.ok) {
      console.error(`[HouseBot] Action failed: ${result.error}`);
      if (decision.action !== 'fold') {
        await api('/table/act', 'POST', { action: 'fold' });
      }
    }
  } catch (err) {
    console.error(`[HouseBot] Error: ${err.message}`);
  }
}

// ============ Main ============

async function main() {
  console.log('🏠 HouseBot starting...');
  
  loadConfig();
  
  if (!config) {
    await register();
  }
  
  // Verify auth
  try {
    const me = await api('/me');
    if (me.error) {
      console.log('[HouseBot] Stored key invalid, re-registering...');
      config = null;
      await register();
    } else {
      console.log(`[HouseBot] Authenticated as ${me.name} (${me.chips} chips)`);
    }
  } catch (err) {
    console.error(`[HouseBot] Auth check failed: ${err.message}`);
    config = null;
    await register();
  }
  
  await ensureJoined();
  
  console.log('[HouseBot] Entering game loop (polling every 2s)...');
  setInterval(gameLoop, POLL_INTERVAL);
  gameLoop();
}

main().catch(err => {
  console.error(`[HouseBot] Fatal: ${err.message}`);
  process.exit(1);
});
