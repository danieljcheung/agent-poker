// Card types
export type Suit = 'h' | 'd' | 'c' | 's';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

// Hand rankings (higher = better)
export enum HandRank {
  HIGH_CARD = 0,
  PAIR = 1,
  TWO_PAIR = 2,
  THREE_OF_A_KIND = 3,
  STRAIGHT = 4,
  FLUSH = 5,
  FULL_HOUSE = 6,
  FOUR_OF_A_KIND = 7,
  STRAIGHT_FLUSH = 8,
  ROYAL_FLUSH = 9,
}

export interface HandEvaluation {
  rank: HandRank;
  rankName: string;
  kickers: number[]; // for tiebreaking
  description: string; // e.g. "Pair of Kings"
}

// Game types
export type Phase = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type PlayerStatus = 'active' | 'folded' | 'all_in' | 'sitting_out';
export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'all_in';

export interface Player {
  agentId: string;
  name: string;
  chips: number;
  holeCards: Card[];
  bet: number;
  totalBet: number; // total bet this hand
  status: PlayerStatus;
  seatIndex: number;
  hasActed: boolean;
  sitOutCount: number; // consecutive sit-out hands
}

export interface ChatMessage {
  from: string;
  fromName: string;
  text: string;
  timestamp: number;
}

export interface GameAction {
  agentId: string;
  action: ActionType;
  amount: number;
  timestamp: number;
}

export interface HandRecord {
  handId: string;
  tableId: string;
  players: { id: string; name: string; startChips: number }[];
  holeCards: Record<string, Card[]>;
  communityCards: Card[];
  actions: GameAction[];
  chat: ChatMessage[];
  pot: number;
  winnerId: string | null;
  winnerName: string | null;
  winningHand: string | null;
  startedAt: number;
  endedAt: number;
}

export interface LastHandResult {
  winnerName: string;
  winningHand: string;
  potWon: number;
  handId: string;
}

export interface TableState {
  tableId: string;
  handId: string;
  phase: Phase;
  players: Player[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  currentTurnIndex: number;
  dealerIndex: number;
  smallBlind: number;
  bigBlind: number;
  deck: Card[];
  handRecord: HandRecord | null;
  lastActionTime: number;
  actionTimeoutMs: number;
  lastHandResult: LastHandResult | null;
}

export interface PublicPlayerInfo {
  id: string;
  name: string;
  chips: number;
  status: PlayerStatus;
  bet: number;
}

export interface AgentTableView {
  handId: string;
  phase: Phase;
  yourCards: Card[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  yourChips: number;
  yourBet: number;
  isYourTurn: boolean;
  turn: string | null;
  timeLeftMs: number;
  players: PublicPlayerInfo[];
  recentChat: ChatMessage[];
  availableActions: ActionType[];
}

// DB types
export interface AgentRow {
  id: string;
  name: string;
  api_key_hash: string;
  chips: number;
  hands_played: number;
  hands_won: number;
  llm_provider: string | null;
  llm_model: string | null;
  created_at: number;
  banned: number;
  current_table: string | null;
  rebuys: number;
}

export interface Env {
  DB: D1Database;
  POKER_TABLE: DurableObjectNamespace;
  ENVIRONMENT: string;
  ADMIN_KEY?: string;
}
