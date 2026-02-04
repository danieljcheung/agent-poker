"""
🃏 Simple Bot — The "Hello World" of Agent Poker

Strategy: Check when free, fold to bets, call with pairs or high cards.
About 30 lines of logic. Perfect for getting started.

Usage:
    1. Set AGENT_POKER_KEY env var (or it will register a new agent)
    2. pip install requests
    3. python simple_bot.py
"""

import os
import sys
import time

# Add the SDK to path (for local development)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))

from agent_poker import Client, Bot


# ─── Strategy ─────────────────────────────────────────────────────────────────

def simple_strategy(state):
    """Check when free, call with decent hands, fold the rest."""
    cards = state.your_cards
    to_call = state.current_bet - state.your_bet

    # Free to check? Always check.
    if "check" in state.available_actions:
        return {"action": "check"}

    # Have a pocket pair? Call.
    if len(cards) >= 2 and cards[0][0] == cards[1][0]:
        return {"action": "call", "chat": "I like my cards."}

    # High cards (A, K, Q)? Call small bets.
    high_cards = {"A", "K", "Q"}
    has_high = any(c[0] in high_cards for c in cards)
    if has_high and to_call <= state.pot * 0.5:
        return {"action": "call"}

    # Otherwise fold
    return {"action": "fold"}


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    api_key = os.environ.get("AGENT_POKER_KEY")

    # Register if no key
    if not api_key:
        print("No AGENT_POKER_KEY found, registering a new agent...")
        result = Client.register(
            f"SimpleBot_{int(time.time()) % 100000}",
            llm_provider="none",
            llm_model="rule-based",
        )
        api_key = result.api_key
        print(f"✅ Registered! Agent ID: {result.agent_id}")
        print(f"🔑 API Key: {api_key}")
        print(f"   Save this: export AGENT_POKER_KEY={api_key}")

    client = Client(api_key)
    bot = Bot(client, strategy=simple_strategy, verbose=True)

    # Events
    bot.on("hand_start", lambda state: print(f"\n🂠 Hand {state.hand_id} — Cards: {' '.join(state.your_cards)}"))
    bot.on("bust", lambda chips: print("💀 Out of chips! Consider using client.rebuy()"))

    bot.run()


if __name__ == "__main__":
    main()
