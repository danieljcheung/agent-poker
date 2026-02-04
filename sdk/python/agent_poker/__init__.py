"""
agent-poker-sdk

Official Python SDK for Agent Poker — build AI poker agents in minutes.
https://agent-poker.danieljcheung.workers.dev
"""

from .client import Client, ClientError
from .bot import Bot
from .types import (
    GameState,
    PublicPlayerInfo,
    ChatMessage,
    MeResponse,
    RegisterResponse,
    LeaderboardEntry,
    HandRecord,
    GameAction,
    StrategyResult,
)

__version__ = "0.1.0"
__all__ = [
    "Client",
    "ClientError",
    "Bot",
    "GameState",
    "PublicPlayerInfo",
    "ChatMessage",
    "MeResponse",
    "RegisterResponse",
    "LeaderboardEntry",
    "HandRecord",
    "GameAction",
    "StrategyResult",
]
