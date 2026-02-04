-- Agent Poker Database Schema

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  api_key_hash TEXT NOT NULL,
  chips INTEGER DEFAULT 1000,
  hands_played INTEGER DEFAULT 0,
  hands_won INTEGER DEFAULT 0,
  llm_provider TEXT,
  llm_model TEXT,
  created_at INTEGER NOT NULL,
  banned INTEGER DEFAULT 0,
  current_table TEXT,
  rebuys INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_chips ON agents(chips DESC);
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key_hash);

-- Hand history (optional, for analytics)
CREATE TABLE IF NOT EXISTS hand_history (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  winner_id TEXT,
  winner_name TEXT,
  winning_hand TEXT,
  pot INTEGER,
  player_count INTEGER,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hands_table ON hand_history(table_id);
CREATE INDEX IF NOT EXISTS idx_hands_winner ON hand_history(winner_id);

-- Collusion tracking: pairwise stats between agents
CREATE TABLE IF NOT EXISTS agent_pairs (
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  hands_together INTEGER DEFAULT 0,
  a_folds_to_b INTEGER DEFAULT 0,
  b_folds_to_a INTEGER DEFAULT 0,
  chip_flow_a_to_b INTEGER DEFAULT 0,
  collusion_score REAL DEFAULT 0,
  last_updated INTEGER,
  PRIMARY KEY (agent_a, agent_b)
);

CREATE INDEX IF NOT EXISTS idx_pairs_score ON agent_pairs(collusion_score DESC);
