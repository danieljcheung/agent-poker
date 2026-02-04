import { TableState, Player, Phase, ActionType, Card, GameAction, ChatMessage, HandRecord, AgentTableView, PublicPlayerInfo, LastHandResult } from '../types';
import { createDeck, shuffleDeck, dealCards } from './deck';
import { evaluateHand, compareHands } from './evaluator';

export function createTable(tableId: string): TableState {
  return {
    tableId,
    handId: '',
    phase: 'waiting',
    players: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    currentTurnIndex: -1,
    dealerIndex: 0,
    smallBlind: 10,
    bigBlind: 20,
    deck: [],
    handRecord: null,
    lastActionTime: Date.now(),
    actionTimeoutMs: 15000,
    lastHandResult: null,
  };
}

export function addPlayer(state: TableState, agentId: string, name: string, chips: number): TableState | { error: string } {
  if (state.players.length >= 6) return { error: 'Table is full (max 6)' };
  if (state.players.find(p => p.agentId === agentId)) return { error: 'Already at this table' };
  if (chips < state.bigBlind * 5) return { error: 'Not enough chips (minimum 5x big blind)' };

  const seatIndex = state.players.length;
  const player: Player = {
    agentId,
    name,
    chips,
    holeCards: [],
    bet: 0,
    totalBet: 0,
    status: 'active',
    seatIndex,
    hasActed: false,
    sitOutCount: 0,
  };

  return { ...state, players: [...state.players, player] };
}

export function removePlayer(state: TableState, agentId: string): TableState {
  return { ...state, players: state.players.filter(p => p.agentId !== agentId) };
}

export function canStartHand(state: TableState): boolean {
  const readyPlayers = state.players.filter(p => p.chips >= state.bigBlind && p.status !== 'sitting_out');
  // Also count sitting_out players who have enough chips (they'll auto-fold but still need 2 non-sitting-out)
  return state.phase === 'waiting' && readyPlayers.length >= 2;
}

// Mark a player as sitting out
export function sitOut(state: TableState, agentId: string): TableState | { error: string } {
  const player = state.players.find(p => p.agentId === agentId);
  if (!player) return { error: 'Not at this table' };
  if (player.status === 'sitting_out') return { error: 'Already sitting out' };

  // If in an active hand, can't sit out mid-hand — they'll be marked for next hand
  if (state.phase !== 'waiting' && state.phase !== 'showdown' &&
      (player.status === 'active' || player.status === 'all_in')) {
    return { error: 'Cannot sit out during an active hand. Wait until the hand ends.' };
  }

  return {
    ...state,
    players: state.players.map(p =>
      p.agentId === agentId ? { ...p, status: 'sitting_out' as const } : p
    ),
  };
}

// Return a player to active play
export function sitIn(state: TableState, agentId: string): TableState | { error: string } {
  const player = state.players.find(p => p.agentId === agentId);
  if (!player) return { error: 'Not at this table' };
  if (player.status !== 'sitting_out') return { error: 'Not sitting out' };

  return {
    ...state,
    players: state.players.map(p =>
      p.agentId === agentId ? { ...p, status: 'active' as const, sitOutCount: 0 } : p
    ),
  };
}

// Check if a player can leave (not in an active hand)
export function canLeave(state: TableState, agentId: string): { ok: boolean; error?: string } {
  const player = state.players.find(p => p.agentId === agentId);
  if (!player) return { ok: true }; // not at table, fine

  // Block leaving during active hand
  if (state.phase !== 'waiting' && state.phase !== 'showdown') {
    if (player.status === 'active' || player.status === 'all_in') {
      return { ok: false, error: 'Cannot leave during an active hand. Fold first or wait for the hand to end.' };
    }
  }
  return { ok: true };
}

export function startHand(state: TableState): TableState {
  if (!canStartHand(state)) return state;

  // Calculate dynamic blinds based on average stack
  const allChips = state.players.map(p => p.chips);
  const avgStack = allChips.reduce((a, b) => a + b, 0) / allChips.length;
  const smallBlind = Math.max(10, Math.floor(avgStack / 100));
  const bigBlind = smallBlind * 2;

  const deck = shuffleDeck(createDeck());
  const handId = `hand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Auto-bust: remove players who can't afford the big blind
  let bustedPlayers: Player[] = [];
  let updatedPlayers = state.players.filter(p => {
    if (p.chips < bigBlind && p.status !== 'sitting_out') {
      bustedPlayers.push(p);
      return false; // remove from table
    }
    return true;
  });

  // Increment sitOutCount for sitting_out players, auto-remove after 10
  updatedPlayers = updatedPlayers.map(p => {
    if (p.status === 'sitting_out') {
      return { ...p, sitOutCount: (p.sitOutCount || 0) + 1 };
    }
    return p;
  });
  // Remove players who've sat out 10+ consecutive hands
  updatedPlayers = updatedPlayers.filter(p => !(p.status === 'sitting_out' && p.sitOutCount >= 10));

  // Reset players — only non-sitting-out players with enough chips play
  let players = updatedPlayers
    .filter(p => p.chips >= bigBlind && p.status !== 'sitting_out')
    .map((p, i) => ({
      ...p,
      holeCards: [] as Card[],
      bet: 0,
      totalBet: 0,
      status: 'active' as const,
      seatIndex: i,
      hasActed: false,
    }));

  // Keep sitting_out players at the table but don't deal them in
  const sittingOutPlayers = updatedPlayers.filter(p => p.status === 'sitting_out' || p.chips < bigBlind);

  if (players.length < 2) return state; // not enough active players

  const dealerIndex = state.dealerIndex % players.length;

  // Deal hole cards
  let remaining = deck;
  for (let i = 0; i < players.length; i++) {
    const result = dealCards(remaining, 2);
    players[i] = { ...players[i], holeCards: result.cards };
    remaining = result.remaining;
  }

  // Post blinds
  const sbIndex = players.length === 2 ? dealerIndex : (dealerIndex + 1) % players.length;
  const bbIndex = (sbIndex + 1) % players.length;

  const sbAmount = Math.min(smallBlind, players[sbIndex].chips);
  const bbAmount = Math.min(bigBlind, players[bbIndex].chips);

  players[sbIndex] = {
    ...players[sbIndex],
    chips: players[sbIndex].chips - sbAmount,
    bet: sbAmount,
    totalBet: sbAmount,
  };
  players[bbIndex] = {
    ...players[bbIndex],
    chips: players[bbIndex].chips - bbAmount,
    bet: bbAmount,
    totalBet: bbAmount,
  };

  const pot = sbAmount + bbAmount;
  const firstToAct = (bbIndex + 1) % players.length;

  const handRecord: HandRecord = {
    handId,
    tableId: state.tableId,
    players: players.map(p => ({ id: p.agentId, name: p.name, startChips: p.chips + p.bet })),
    holeCards: Object.fromEntries(players.map(p => [p.agentId, p.holeCards])),
    communityCards: [],
    actions: [],
    chat: [],
    pot,
    winnerId: null,
    winnerName: null,
    winningHand: null,
    startedAt: Date.now(),
    endedAt: 0,
  };

  // Merge active players with sitting out players
  const allPlayers = [...players, ...sittingOutPlayers.map((p, i) => ({
    ...p,
    seatIndex: players.length + i,
  }))];

  return {
    ...state,
    handId,
    phase: 'preflop',
    players: allPlayers,
    communityCards: [],
    pot,
    currentBet: bigBlind,
    currentTurnIndex: firstToAct,
    dealerIndex,
    smallBlind,
    bigBlind,
    deck: remaining,
    handRecord,
    lastActionTime: Date.now(),
  };
}

export function getActivePlayers(state: TableState): Player[] {
  return state.players.filter(p => p.status === 'active' || p.status === 'all_in');
}

export function getActionPlayers(state: TableState): Player[] {
  return state.players.filter(p => p.status === 'active');
}

export function processAction(state: TableState, agentId: string, action: ActionType, amount?: number): TableState | { error: string } {
  const playerIndex = state.players.findIndex(p => p.agentId === agentId);
  if (playerIndex === -1) return { error: 'Not at this table' };
  if (state.currentTurnIndex !== playerIndex) return { error: 'Not your turn' };
  if (state.phase === 'waiting' || state.phase === 'showdown') return { error: 'No active hand' };

  const player = state.players[playerIndex];
  if (player.status !== 'active') return { error: 'Cannot act (folded or all-in)' };

  let newState = { ...state, players: [...state.players] };
  let updatedPlayer = { ...player };

  const gameAction: GameAction = {
    agentId,
    action,
    amount: 0,
    timestamp: Date.now(),
  };

  switch (action) {
    case 'fold': {
      updatedPlayer.status = 'folded';
      break;
    }
    case 'check': {
      if (state.currentBet > player.bet) {
        return { error: 'Cannot check — there is a bet to match. Call, raise, or fold.' };
      }
      break;
    }
    case 'call': {
      const callAmount = Math.min(state.currentBet - player.bet, player.chips);
      updatedPlayer.chips -= callAmount;
      updatedPlayer.bet += callAmount;
      updatedPlayer.totalBet += callAmount;
      newState.pot += callAmount;
      gameAction.amount = callAmount;
      if (updatedPlayer.chips === 0) updatedPlayer.status = 'all_in';
      break;
    }
    case 'raise': {
      const raiseAmount = amount || state.currentBet * 2;
      const totalNeeded = raiseAmount - player.bet;
      if (totalNeeded > player.chips) {
        return { error: `Not enough chips. You have ${player.chips}, need ${totalNeeded}` };
      }
      if (raiseAmount < state.currentBet * 2 && totalNeeded < player.chips) {
        return { error: `Minimum raise is ${state.currentBet * 2}` };
      }
      updatedPlayer.chips -= totalNeeded;
      updatedPlayer.bet += totalNeeded;
      updatedPlayer.totalBet += totalNeeded;
      newState.pot += totalNeeded;
      newState.currentBet = raiseAmount;
      gameAction.amount = raiseAmount;
      // Reset hasActed for others since there's a new raise
      newState.players = newState.players.map(p =>
        p.agentId === agentId ? p : { ...p, hasActed: p.status !== 'active' ? p.hasActed : false }
      );
      if (updatedPlayer.chips === 0) updatedPlayer.status = 'all_in';
      break;
    }
    case 'all_in': {
      const allInAmount = player.chips;
      updatedPlayer.bet += allInAmount;
      updatedPlayer.totalBet += allInAmount;
      newState.pot += allInAmount;
      updatedPlayer.chips = 0;
      updatedPlayer.status = 'all_in';
      gameAction.amount = updatedPlayer.bet;
      if (updatedPlayer.bet > state.currentBet) {
        newState.currentBet = updatedPlayer.bet;
        newState.players = newState.players.map(p =>
          p.agentId === agentId ? p : { ...p, hasActed: p.status !== 'active' ? p.hasActed : false }
        );
      }
      break;
    }
  }

  updatedPlayer.hasActed = true;
  newState.players[playerIndex] = updatedPlayer;

  // Record action
  if (newState.handRecord) {
    newState.handRecord = {
      ...newState.handRecord,
      actions: [...newState.handRecord.actions, gameAction],
      pot: newState.pot,
    };
  }

  // Check if only one player left
  const activePlayers = getActivePlayers(newState);
  if (activePlayers.length === 1) {
    return resolveHand(newState);
  }

  // Check if betting round is over
  const actionPlayers = getActionPlayers(newState);
  const allActed = actionPlayers.every(p => p.hasActed);
  const allMatched = actionPlayers.every(p => p.bet === newState.currentBet || p.status === 'all_in');

  if (allActed && allMatched) {
    return advancePhase(newState);
  }

  // Move to next active player
  newState = moveToNextPlayer(newState);
  newState.lastActionTime = Date.now();

  return newState;
}

function moveToNextPlayer(state: TableState): TableState {
  let next = (state.currentTurnIndex + 1) % state.players.length;
  let attempts = 0;
  while (state.players[next].status !== 'active' && attempts < state.players.length) {
    next = (next + 1) % state.players.length;
    attempts++;
  }
  return { ...state, currentTurnIndex: next };
}

function advancePhase(state: TableState): TableState {
  // Reset bets for new round
  let newState = {
    ...state,
    players: state.players.map(p => ({ ...p, bet: 0, hasActed: p.status !== 'active' })),
    currentBet: 0,
  };

  // Deal community cards
  let nextPhase: Phase;
  let newCards: Card[] = [];
  let remaining = state.deck;

  switch (state.phase) {
    case 'preflop': {
      nextPhase = 'flop';
      const result = dealCards(remaining, 3);
      newCards = result.cards;
      remaining = result.remaining;
      break;
    }
    case 'flop': {
      nextPhase = 'turn';
      const result = dealCards(remaining, 1);
      newCards = result.cards;
      remaining = result.remaining;
      break;
    }
    case 'turn': {
      nextPhase = 'river';
      const result = dealCards(remaining, 1);
      newCards = result.cards;
      remaining = result.remaining;
      break;
    }
    case 'river': {
      return resolveHand(newState);
    }
    default:
      return newState;
  }

  const communityCards = [...state.communityCards, ...newCards];

  // Update hand record
  let handRecord = newState.handRecord;
  if (handRecord) {
    handRecord = { ...handRecord, communityCards };
  }

  // If no one can act (all all-in), keep advancing
  const actionPlayers = newState.players.filter(p => p.status === 'active');
  
  newState = {
    ...newState,
    phase: nextPhase,
    communityCards,
    deck: remaining,
    handRecord,
    lastActionTime: Date.now(),
  };

  if (actionPlayers.length <= 1) {
    // Everyone is all-in or folded, run out remaining cards
    return advancePhase(newState);
  }

  // Find first player after dealer
  const dealerIndex = state.dealerIndex;
  let firstActor = (dealerIndex + 1) % newState.players.length;
  let attempts = 0;
  while (newState.players[firstActor].status !== 'active' && attempts < newState.players.length) {
    firstActor = (firstActor + 1) % newState.players.length;
    attempts++;
  }

  return { ...newState, currentTurnIndex: firstActor };
}

function resolveHand(state: TableState): TableState {
  const activePlayers = getActivePlayers(state);

  let winnerId: string;
  let winnerName: string;
  let winningHandDesc: string;

  if (activePlayers.length === 1) {
    // Everyone else folded — winner takes entire pot
    winnerId = activePlayers[0].agentId;
    winnerName = activePlayers[0].name;
    winningHandDesc = 'Last player standing';

    const players = state.players.map(p => {
      if (p.agentId === winnerId) {
        return { ...p, chips: p.chips + state.pot, bet: 0, status: 'active' as const };
      }
      return { ...p, bet: 0 };
    });

    const handRecord: HandRecord | null = state.handRecord ? {
      ...state.handRecord,
      winnerId,
      winnerName,
      winningHand: winningHandDesc,
      endedAt: Date.now(),
      communityCards: state.communityCards,
    } : null;

    const lastHandResult: LastHandResult = {
      winnerName,
      winningHand: winningHandDesc,
      potWon: state.pot,
      handId: state.handId,
    };

    const activePlayers_ = players.filter(p => p.status !== 'sitting_out');
    return {
      ...state,
      phase: 'showdown',
      players,
      pot: 0,
      currentTurnIndex: -1,
      handRecord,
      dealerIndex: (state.dealerIndex + 1) % (activePlayers_.length || 1),
      lastHandResult,
    };
  }

  // Showdown with split pot support
  // Build side pots based on all-in amounts
  const pots = calculateSidePots(state);

  // Evaluate all active players' hands
  const evaluations = new Map<string, ReturnType<typeof evaluateHand>>();
  for (const player of activePlayers) {
    const allCards = [...player.holeCards, ...state.communityCards];
    evaluations.set(player.agentId, evaluateHand(allCards));
  }

  // Award each pot to its winner(s)
  let players = [...state.players];
  let mainWinnerId = '';
  let mainWinnerName = '';
  let mainWinningHand = '';

  for (const pot of pots) {
    // Find the best hand among eligible players for this pot
    let bestEval: ReturnType<typeof evaluateHand> | null = null;
    const potWinners: Player[] = [];

    for (const eligibleId of pot.eligible) {
      const eval_ = evaluations.get(eligibleId);
      if (!eval_) continue;

      if (!bestEval || compareHands(eval_, bestEval) > 0) {
        bestEval = eval_;
        potWinners.length = 0;
        potWinners.push(players.find(p => p.agentId === eligibleId)!);
      } else if (bestEval && compareHands(eval_, bestEval) === 0) {
        // Tie — split this pot
        potWinners.push(players.find(p => p.agentId === eligibleId)!);
      }
    }

    if (potWinners.length === 0) continue;

    // Split pot evenly among winners, remainder to first positional winner
    const share = Math.floor(pot.amount / potWinners.length);
    const remainder = pot.amount - share * potWinners.length;

    players = players.map(p => {
      const winnerIdx = potWinners.findIndex(w => w.agentId === p.agentId);
      if (winnerIdx >= 0) {
        const bonus = winnerIdx === 0 ? remainder : 0;
        return { ...p, chips: p.chips + share + bonus };
      }
      return p;
    });

    // Track the main pot winner for hand record
    if (!mainWinnerId) {
      mainWinnerId = potWinners[0].agentId;
      mainWinnerName = potWinners[0].name;
      mainWinningHand = bestEval!.description;
    }
  }

  // Reset bets and statuses
  players = players.map(p => ({ ...p, bet: 0, status: p.status === 'folded' ? 'folded' as const : 'active' as const }));

  winnerId = mainWinnerId;
  winnerName = mainWinnerName;
  winningHandDesc = mainWinningHand;

  const handRecord: HandRecord | null = state.handRecord ? {
    ...state.handRecord,
    winnerId,
    winnerName,
    winningHand: winningHandDesc,
    endedAt: Date.now(),
    communityCards: state.communityCards,
  } : null;

  const lastHandResult: LastHandResult = {
    winnerName,
    winningHand: winningHandDesc,
    potWon: state.handRecord?.pot || 0,
    handId: state.handId,
  };

  const activePlayers_ = players.filter(p => p.status !== 'sitting_out');
  return {
    ...state,
    phase: 'showdown',
    players,
    pot: 0,
    currentTurnIndex: -1,
    handRecord,
    dealerIndex: (state.dealerIndex + 1) % (activePlayers_.length || 1),
    lastHandResult,
  };
}

// Calculate side pots for all-in situations
function calculateSidePots(state: TableState): { amount: number; eligible: string[] }[] {
  // Get all players who put chips in (not just active — folded players contributed too)
  const contributors = state.players
    .filter(p => p.totalBet > 0)
    .map(p => ({ agentId: p.agentId, totalBet: p.totalBet, status: p.status }))
    .sort((a, b) => a.totalBet - b.totalBet);

  const pots: { amount: number; eligible: string[] }[] = [];
  let previousBet = 0;

  // Get unique bet levels from all-in players
  const betLevels = [...new Set(contributors.map(c => c.totalBet))].sort((a, b) => a - b);

  for (const level of betLevels) {
    const increment = level - previousBet;
    if (increment <= 0) continue;

    // Everyone who bet at least this level contributes to this pot
    const potContributors = contributors.filter(c => c.totalBet >= level);
    const potAmount = increment * potContributors.length;

    // Only active/all-in players are eligible to win (not folded)
    const eligible = potContributors
      .filter(c => c.status === 'active' || c.status === 'all_in')
      .map(c => c.agentId);

    if (potAmount > 0 && eligible.length > 0) {
      pots.push({ amount: potAmount, eligible });
    }

    previousBet = level;
  }

  return pots;
}

export function getAgentView(state: TableState, agentId: string): AgentTableView {
  const player = state.players.find(p => p.agentId === agentId);
  const isYourTurn = state.currentTurnIndex >= 0 &&
    state.players[state.currentTurnIndex]?.agentId === agentId;

  const availableActions: ActionType[] = [];
  if (isYourTurn && player?.status === 'active') {
    availableActions.push('fold');
    if (state.currentBet <= (player?.bet || 0)) {
      availableActions.push('check');
    } else {
      availableActions.push('call');
    }
    if ((player?.chips || 0) > state.currentBet - (player?.bet || 0)) {
      availableActions.push('raise');
    }
    availableActions.push('all_in');
  }

  const turnPlayer = state.currentTurnIndex >= 0 ? state.players[state.currentTurnIndex] : null;

  // Show hole cards in showdown for active players
  const showCards = state.phase === 'showdown';

  return {
    handId: state.handId,
    phase: state.phase,
    yourCards: player?.holeCards || [],
    communityCards: state.communityCards,
    pot: state.pot,
    currentBet: state.currentBet,
    yourChips: player?.chips || 0,
    yourBet: player?.bet || 0,
    isYourTurn,
    turn: turnPlayer?.agentId || null,
    timeLeftMs: state.actionTimeoutMs - (Date.now() - state.lastActionTime),
    players: state.players.map(p => ({
      id: p.agentId,
      name: p.name,
      chips: p.chips,
      status: p.status,
      bet: p.bet,
    })),
    recentChat: state.handRecord?.chat.slice(-10) || [],
    availableActions,
  };
}

export function addChat(state: TableState, agentId: string, name: string, text: string): TableState {
  const msg: ChatMessage = {
    from: agentId,
    fromName: name,
    text,
    timestamp: Date.now(),
  };

  if (!state.handRecord) return state;

  return {
    ...state,
    handRecord: {
      ...state.handRecord,
      chat: [...state.handRecord.chat, msg],
    },
  };
}

export function handleTimeout(state: TableState): TableState {
  if (state.phase === 'waiting' || state.phase === 'showdown') return state;
  if (state.currentTurnIndex < 0) return state;

  const elapsed = Date.now() - state.lastActionTime;
  if (elapsed < state.actionTimeoutMs) return state;

  // Auto-fold the player who timed out
  const player = state.players[state.currentTurnIndex];
  if (!player || player.status !== 'active') return state;

  const result = processAction(state, player.agentId, 'fold');
  if ('error' in result) return state;
  return result;
}
