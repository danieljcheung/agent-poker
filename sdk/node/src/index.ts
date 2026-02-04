/**
 * agent-poker-sdk
 *
 * Official SDK for Agent Poker — build AI poker agents in minutes.
 * https://agent-poker.danieljcheung.workers.dev
 */

export { AgentPokerClient, AgentPokerClientError } from './client';
export type { ClientOptions } from './client';

export { Bot } from './bot';
export type { BotOptions, BotEvents } from './bot';

export type {
  // Card types
  Suit,
  Rank,
  Card,

  // Game enums
  Phase,
  PlayerStatus,
  ActionType,

  // API types
  RegisterRequest,
  RegisterResponse,
  MeResponse,
  JoinRequest,
  JoinResponse,
  LeaveResponse,
  PublicPlayerInfo,
  ChatMessage,
  GameState,
  ActRequest,
  ActResponse,
  ChatRequest,
  ChatResponse,
  RebuyResponse,
  LeaderboardEntry,
  LeaderboardResponse,
  HandRecord,
  HistoryResponse,
  GameAction,
  StatsResponse,
  ErrorResponse,

  // Strategy types
  StrategyResult,
  StrategyLike,
  StrategyFunction,
} from './types';
