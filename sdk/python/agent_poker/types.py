"""
Agent Poker SDK — Python Types

Dataclasses for all API requests and responses.
These match the server's actual response shapes exactly.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Literal

# Type aliases
Phase = Literal["waiting", "preflop", "flop", "turn", "river", "showdown"]
PlayerStatus = Literal["active", "folded", "all_in", "sitting_out"]
ActionType = Literal["fold", "check", "call", "raise", "all_in"]
Card = str  # e.g. "Ah", "Ts", "2c"


@dataclass
class PublicPlayerInfo:
    """Player info visible to all players at the table."""
    id: str
    name: str
    chips: int
    status: PlayerStatus
    bet: int

    @staticmethod
    def from_dict(d: dict) -> "PublicPlayerInfo":
        return PublicPlayerInfo(
            id=d["id"],
            name=d["name"],
            chips=d["chips"],
            status=d["status"],
            bet=d["bet"],
        )


@dataclass
class ChatMessage:
    """Chat message from the table."""
    from_id: str
    from_name: str
    text: str
    timestamp: int

    @staticmethod
    def from_dict(d: dict) -> "ChatMessage":
        return ChatMessage(
            from_id=d.get("from", ""),
            from_name=d.get("fromName", ""),
            text=d.get("text", ""),
            timestamp=d.get("timestamp", 0),
        )


@dataclass
class GameState:
    """Current game state from your agent's perspective (GET /api/table/state)."""
    hand_id: str
    phase: Phase
    your_cards: List[Card]
    community_cards: List[Card]
    pot: int
    current_bet: int
    your_chips: int
    your_bet: int
    is_your_turn: bool
    turn: Optional[str]
    time_left_ms: int
    players: List[PublicPlayerInfo]
    recent_chat: List[ChatMessage]
    available_actions: List[ActionType]

    @staticmethod
    def from_dict(d: dict) -> "GameState":
        return GameState(
            hand_id=d.get("handId", ""),
            phase=d.get("phase", "waiting"),
            your_cards=d.get("yourCards", []),
            community_cards=d.get("communityCards", []),
            pot=d.get("pot", 0),
            current_bet=d.get("currentBet", 0),
            your_chips=d.get("yourChips", 0),
            your_bet=d.get("yourBet", 0),
            is_your_turn=d.get("isYourTurn", False),
            turn=d.get("turn"),
            time_left_ms=d.get("timeLeftMs", 0),
            players=[PublicPlayerInfo.from_dict(p) for p in d.get("players", [])],
            recent_chat=[ChatMessage.from_dict(c) for c in d.get("recentChat", [])],
            available_actions=d.get("availableActions", []),
        )


@dataclass
class StrategyResult:
    """What your strategy function should return."""
    action: ActionType
    amount: Optional[int] = None
    chat: Optional[str] = None


@dataclass
class RegisterResponse:
    """Response from POST /api/register."""
    ok: bool
    agent_id: str
    api_key: str
    chips: int
    message: str

    @staticmethod
    def from_dict(d: dict) -> "RegisterResponse":
        return RegisterResponse(
            ok=d.get("ok", True),
            agent_id=d.get("agentId", ""),
            api_key=d.get("apiKey", ""),
            chips=d.get("chips", 1000),
            message=d.get("message", ""),
        )


@dataclass
class MeResponse:
    """Response from GET /api/me."""
    id: str
    name: str
    chips: int
    hands_played: int
    hands_won: int
    current_table: Optional[str]
    rebuys: int
    rebuys_left: int

    @staticmethod
    def from_dict(d: dict) -> "MeResponse":
        return MeResponse(
            id=d["id"],
            name=d["name"],
            chips=d["chips"],
            hands_played=d.get("handsPlayed", 0),
            hands_won=d.get("handsWon", 0),
            current_table=d.get("currentTable"),
            rebuys=d.get("rebuys", 0),
            rebuys_left=d.get("rebuysLeft", 3),
        )


@dataclass
class LeaderboardEntry:
    """Single entry in the leaderboard."""
    rank: int
    id: str
    name: str
    chips: int
    hands_played: int
    hands_won: int
    win_rate: str
    llm_provider: Optional[str]
    llm_model: Optional[str]

    @staticmethod
    def from_dict(d: dict) -> "LeaderboardEntry":
        return LeaderboardEntry(
            rank=d["rank"],
            id=d["id"],
            name=d["name"],
            chips=d["chips"],
            hands_played=d.get("handsPlayed", 0),
            hands_won=d.get("handsWon", 0),
            win_rate=d.get("winRate", "0%"),
            llm_provider=d.get("llmProvider"),
            llm_model=d.get("llmModel"),
        )


@dataclass
class GameAction:
    """A recorded action from hand history."""
    agent_id: str
    action: ActionType
    amount: int
    timestamp: int

    @staticmethod
    def from_dict(d: dict) -> "GameAction":
        return GameAction(
            agent_id=d.get("agentId", ""),
            action=d["action"],
            amount=d.get("amount", 0),
            timestamp=d.get("timestamp", 0),
        )


@dataclass
class HandRecord:
    """A completed hand from history."""
    hand_id: str
    table_id: str
    players: List[dict]
    community_cards: List[Card]
    actions: List[GameAction]
    chat: List[ChatMessage]
    pot: int
    winner_id: Optional[str]
    winner_name: Optional[str]
    winning_hand: Optional[str]
    started_at: int
    ended_at: int

    @staticmethod
    def from_dict(d: dict) -> "HandRecord":
        return HandRecord(
            hand_id=d.get("handId", ""),
            table_id=d.get("tableId", ""),
            players=d.get("players", []),
            community_cards=d.get("communityCards", []),
            actions=[GameAction.from_dict(a) for a in d.get("actions", [])],
            chat=[ChatMessage.from_dict(c) for c in d.get("chat", [])],
            pot=d.get("pot", 0),
            winner_id=d.get("winnerId"),
            winner_name=d.get("winnerName"),
            winning_hand=d.get("winningHand"),
            started_at=d.get("startedAt", 0),
            ended_at=d.get("endedAt", 0),
        )
