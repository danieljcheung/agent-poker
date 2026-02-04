"""
🔢 Math Bot — Pure Hand Strength + Pot Odds

Strategy: Evaluates hand strength numerically, calculates pot odds,
and makes mathematically optimal decisions. No LLM needed.

Features:
- Pre-flop hand rankings (pairs, suited connectors, etc.)
- Post-flop hand evaluation (pairs, two pair, trips, etc.)
- Pot odds calculation
- Position-aware aggression
- Dynamic bet sizing

Usage:
    1. Set AGENT_POKER_KEY env var (or it will register)
    2. pip install requests
    3. python math_bot.py
"""

import os
import sys
import time
from collections import Counter

# Add SDK to path for local dev
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))

from agent_poker import Client, Bot, GameState


# ─── Hand Evaluation ──────────────────────────────────────────────────────────

RANK_VALUES = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
    "9": 9, "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
}


def rank_value(card: str) -> int:
    return RANK_VALUES.get(card[0], 0)


def card_suit(card: str) -> str:
    return card[1]


def preflop_strength(cards: list[str]) -> float:
    """
    Evaluate pre-flop hand strength (0-1 scale).
    Based on simplified Sklansky hand rankings.
    """
    values = sorted([rank_value(c) for c in cards], reverse=True)
    a, b = values[0], values[1]
    suited = card_suit(cards[0]) == card_suit(cards[1])
    gap = a - b

    # Pocket pairs
    if a == b:
        if a >= 13: return 0.95  # KK, AA
        if a >= 10: return 0.85  # TT, JJ, QQ
        if a >= 7:  return 0.70  # 77-99
        return 0.55               # 22-66

    # Ace-high
    if a == 14:
        if b >= 13: return 0.90 if suited else 0.85  # AK
        if b >= 12: return 0.80 if suited else 0.75  # AQ
        if b >= 11: return 0.72 if suited else 0.65  # AJ
        if b >= 10: return 0.68 if suited else 0.60  # AT
        return 0.55 if suited else 0.40               # Ax

    # Broadway cards (T+)
    if a >= 10 and b >= 10:
        return 0.65 if suited else 0.55

    # Suited connectors
    if suited and gap <= 2 and b >= 5:
        return 0.50 + (b / 30)

    # Connected cards
    if gap <= 1 and b >= 7:
        return 0.45

    # Everything else
    return 0.35 if suited else 0.25


def postflop_strength(hole_cards: list[str], community_cards: list[str]) -> float:
    """
    Evaluate post-flop hand strength (0-1 scale).
    Checks for made hands using hole cards + community cards.
    """
    all_cards = hole_cards + community_cards
    ranks = [rank_value(c) for c in all_cards]
    suits = [card_suit(c) for c in all_cards]

    rank_counts = Counter(ranks)
    counts = sorted(rank_counts.values(), reverse=True)

    suit_counts = Counter(suits)
    max_suit_count = max(suit_counts.values())

    # Flush check
    has_flush = max_suit_count >= 5

    # Straight check
    unique_ranks = sorted(set(ranks))
    has_straight = False
    for i in range(len(unique_ranks) - 4):
        if unique_ranks[i + 4] - unique_ranks[i] == 4:
            has_straight = True
            break
    # Ace-low straight
    if {14, 2, 3, 4, 5}.issubset(set(ranks)):
        has_straight = True

    # Score based on hand ranking
    if has_flush and has_straight: return 0.98  # Straight flush
    if counts[0] == 4:             return 0.96  # Four of a kind
    if counts[0] == 3 and len(counts) > 1 and counts[1] == 2: return 0.93  # Full house
    if has_flush:                  return 0.88  # Flush
    if has_straight:               return 0.82  # Straight
    if counts[0] == 3:             return 0.72  # Three of a kind
    if counts[0] == 2 and len(counts) > 1 and counts[1] == 2: return 0.60  # Two pair
    if counts[0] == 2:
        # Pair — check if it uses a hole card
        pair_rank = [r for r, c in rank_counts.items() if c == 2][0]
        hole_ranks = [rank_value(c) for c in hole_cards]
        if pair_rank in hole_ranks:
            return 0.40 + (pair_rank / 30)  # ~0.47 for 2s, ~0.87 for As
        return 0.35  # Board pair only

    # High card
    max_hole = max(rank_value(c) for c in hole_cards)
    return 0.15 + (max_hole / 50)


def pot_odds(to_call: int, pot: int) -> float:
    """
    Calculate pot odds: risk vs reward.
    Returns 0-1 where lower = better odds for calling.
    """
    if to_call == 0:
        return 0.0
    return to_call / (pot + to_call)


# ─── Strategy ─────────────────────────────────────────────────────────────────

def math_strategy(state: GameState) -> dict:
    """Make decisions based on hand strength and pot odds."""
    to_call = state.current_bet - state.your_bet
    odds = pot_odds(to_call, state.pot)

    # Calculate strength based on phase
    if state.phase == "preflop":
        strength = preflop_strength(state.your_cards)
    else:
        strength = postflop_strength(state.your_cards, state.community_cards)

    # Position bonus (later = better)
    turn_id = state.turn
    active = [p for p in state.players if p.status == "active"]
    my_idx = next((i for i, p in enumerate(active) if p.id == turn_id), 0)
    if len(active) > 1:
        strength += (my_idx / len(active)) * 0.05

    # Decision logic
    if strength > 0.85:
        # Monster hand — raise big
        if "raise" in state.available_actions:
            amount = max(state.current_bet * 3, int(state.pot * 0.75))
            return {"action": "raise", "amount": amount, "chat": "💪"}
        if "all_in" in state.available_actions and strength > 0.92:
            return {"action": "all_in"}
        return {"action": "call"}

    if strength > 0.60:
        # Strong hand
        if to_call == 0 and "raise" in state.available_actions:
            amount = max(state.current_bet * 2, int(state.pot * 0.5))
            return {"action": "raise", "amount": amount}
        if odds < strength * 0.6:
            return {"action": "call"}
        if "check" in state.available_actions:
            return {"action": "check"}
        return {"action": "fold"}

    if strength > 0.40:
        # Marginal hand
        if "check" in state.available_actions:
            return {"action": "check"}
        if odds < 0.25:
            return {"action": "call"}
        return {"action": "fold"}

    # Weak hand
    if "check" in state.available_actions:
        return {"action": "check"}
    return {"action": "fold"}


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("AGENT_POKER_KEY")

    if not api_key:
        print("No AGENT_POKER_KEY found, registering...")
        result = Client.register(
            f"MathBot_{int(time.time()) % 100000}",
            llm_provider="none",
            llm_model="pot-odds-calculator",
        )
        api_key = result.api_key
        print(f"✅ Registered! Save this: export AGENT_POKER_KEY={api_key}")

    client = Client(api_key)
    bot = Bot(client, strategy=math_strategy, verbose=True)

    def on_hand_start(state):
        strength = preflop_strength(state.your_cards)
        print(f"\n🂠 Cards: {' '.join(state.your_cards)} | Pre-flop strength: {strength * 100:.0f}%")

    bot.on("hand_start", on_hand_start)
    bot.run()


if __name__ == "__main__":
    main()
