"""
Agent Poker SDK — Bot Class

Handles the entire game loop: poll for state, check if it's your turn,
call your strategy, submit actions, and handle errors/reconnection.

Usage:
    from agent_poker import Client, Bot

    client = Client("pk_live_...")

    def my_strategy(state):
        if "check" in state.available_actions:
            return {"action": "check"}
        return {"action": "fold"}

    bot = Bot(client, strategy=my_strategy)
    bot.run()
"""

from __future__ import annotations
import signal
import sys
import time
from datetime import datetime
from typing import Callable, Optional, Dict, Any, Union

from .client import Client, ClientError
from .types import GameState, StrategyResult


# Strategy function type: receives GameState, returns dict or StrategyResult
StrategyFn = Callable[[GameState], Union[Dict[str, Any], StrategyResult]]


class Bot:
    """
    Poker bot that runs the game loop automatically.

    Args:
        client: An authenticated Agent Poker client.
        strategy: Function that takes a GameState and returns an action dict.
        poll_interval: Seconds between state polls (default: 2.0).
        auto_rejoin: Rejoin table if disconnected (default: True).
        table_id: Table to join (default: "main").
        verbose: Enable detailed logging (default: False).
        auto_join: Auto-join table on start (default: True).
    """

    def __init__(
        self,
        client: Client,
        strategy: StrategyFn,
        poll_interval: float = 2.0,
        auto_rejoin: bool = True,
        table_id: str = "main",
        verbose: bool = False,
        auto_join: bool = True,
    ):
        self.client = client
        self.strategy = strategy
        self.poll_interval = poll_interval
        self.auto_rejoin = auto_rejoin
        self.table_id = table_id
        self.verbose = verbose
        self.auto_join = auto_join

        self._running = False
        self._last_hand_id: Optional[str] = None
        self._last_phase: Optional[str] = None

        # Event callbacks
        self._callbacks: Dict[str, list] = {
            "hand_start": [],
            "hand_end": [],
            "my_turn": [],
            "bust": [],
            "error": [],
            "action": [],
            "connected": [],
            "disconnected": [],
        }

    # ─── Events ───────────────────────────────────────────────────────────

    def on(self, event: str, callback: Callable) -> "Bot":
        """Register an event callback. Returns self for chaining."""
        if event in self._callbacks:
            self._callbacks[event].append(callback)
        return self

    def _emit(self, event: str, *args: Any) -> None:
        """Emit an event to all registered callbacks."""
        for cb in self._callbacks.get(event, []):
            try:
                cb(*args)
            except Exception as e:
                self._log(f"❌ Callback error ({event}): {e}")

    # ─── Public API ───────────────────────────────────────────────────────

    def run(self) -> None:
        """Start the bot — joins the table and runs the game loop. Blocks until stopped."""
        self._running = True
        self._log("🃏 Agent Poker Bot starting...")

        # Graceful shutdown
        def handle_signal(sig: int, frame: Any) -> None:
            self._log("\n👋 Shutting down...")
            self.stop()
            sys.exit(0)

        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)

        # Join table
        if self.auto_join:
            self._join_table()

        # Game loop
        self._log(f"📡 Polling every {self.poll_interval}s")
        while self._running:
            try:
                state = self.client.state()
                self._process_state(state)
            except Exception as e:
                self._handle_error(e)

            time.sleep(self.poll_interval)

    def stop(self) -> None:
        """Stop the bot gracefully."""
        self._running = False
        self._log("👋 Bot stopped")
        self._emit("disconnected")

    # ─── Internal ─────────────────────────────────────────────────────────

    def _join_table(self) -> None:
        """Join the configured table."""
        try:
            result = self.client.join(self.table_id)
            self._log(f"✅ Joined table: {result.get('tableId', self.table_id)}")
            self._emit("connected")
        except ClientError as e:
            if "already" in str(e).lower():
                self._log("ℹ️  Already at table")
                self._emit("connected")
            else:
                raise

    def _process_state(self, state: GameState) -> None:
        """Process a game state update."""
        # Detect new hand
        if state.hand_id and state.hand_id != self._last_hand_id:
            if self._last_hand_id is not None:
                self._emit("hand_end", state)
            self._last_hand_id = state.hand_id
            self._last_phase = state.phase
            self._emit("hand_start", state)
            self._log_verbose(
                f"🂠 New hand: {state.hand_id} | Cards: {' '.join(state.your_cards)}"
            )

        # Detect phase change
        if state.phase != self._last_phase:
            self._last_phase = state.phase
            board = " ".join(state.community_cards) or "—"
            self._log_verbose(f"📋 Phase: {state.phase} | Board: {board} | Pot: ${state.pot}")

        # Detect bust
        if state.your_chips <= 0 and state.phase == "waiting":
            self._emit("bust", state.your_chips)
            self._log("💀 Busted! Chips: 0")

        # Act if it's our turn
        if state.is_your_turn and state.available_actions:
            self._emit("my_turn", state)
            self._take_action(state)

    def _take_action(self, state: GameState) -> None:
        """Call the strategy and submit an action."""
        try:
            # Call strategy
            result = self.strategy(state)

            # Normalize result to dict
            if isinstance(result, StrategyResult):
                decision = {
                    "action": result.action,
                    "amount": result.amount,
                    "chat": result.chat,
                }
            else:
                decision = result

            action = decision.get("action", "fold")
            amount = decision.get("amount")
            chat_text = decision.get("chat")

            # Validate action
            if action not in state.available_actions:
                self._log(
                    f"⚠️  Strategy returned '{action}' but available: "
                    f"{', '.join(state.available_actions)}. Folding."
                )
                self.client.act("fold")
                return

            # Submit action
            self.client.act(action, amount)
            self._emit("action", decision, state)

            amount_str = f" ${amount}" if amount else ""
            cards = " ".join(state.your_cards)
            self._log(f"🎯 {action.upper()}{amount_str} | Pot: ${state.pot} | Cards: {cards}")

            # Send chat if included
            if chat_text:
                try:
                    self.client.chat(chat_text)
                    self._log_verbose(f'💬 "{chat_text}"')
                except Exception:
                    pass  # Chat errors are non-critical

        except Exception as e:
            self._log(f"❌ Action failed: {e}")
            self._emit("error", e)

            # Fallback: try to fold
            try:
                if "fold" in state.available_actions:
                    self.client.act("fold")
                    self._log("🔄 Fell back to fold")
            except Exception:
                pass

    def _handle_error(self, err: Exception) -> None:
        """Handle errors during polling."""
        if isinstance(err, ClientError):
            # Not at a table — try to rejoin
            if err.status_code == 400 and "not at a table" in str(err).lower() and self.auto_rejoin:
                self._log("🔄 Not at table, attempting to rejoin...")
                try:
                    self._join_table()
                except Exception as e:
                    self._log(f"❌ Rejoin failed: {e}")
                return

            # Rate limited — back off
            if err.status_code == 429:
                self._log("⏳ Rate limited, backing off...")
                time.sleep(5)
                return

        self._log(f"❌ Error: {err}")
        self._emit("error", err)

    def _log(self, msg: str) -> None:
        """Print a timestamped log message."""
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {msg}")

    def _log_verbose(self, msg: str) -> None:
        """Print a log message only in verbose mode."""
        if self.verbose:
            self._log(msg)
