CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  faction VARCHAR(16) NULL,
  faction_locked BOOLEAN NOT NULL DEFAULT FALSE,
  role VARCHAR(16) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resource_last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resource_food INTEGER NOT NULL DEFAULT 500,
  resource_wood INTEGER NOT NULL DEFAULT 400,
  resource_iron INTEGER NOT NULL DEFAULT 300,
  resource_manpower INTEGER NOT NULL DEFAULT 250,
  soldiers INTEGER NOT NULL DEFAULT 100,
  army_name VARCHAR(64) DEFAULT 'Blue Army'
);

CREATE TABLE IF NOT EXISTS buildings (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  farm INTEGER NOT NULL DEFAULT 1,
  lumbermill INTEGER NOT NULL DEFAULT 1,
  ironmine INTEGER NOT NULL DEFAULT 1,
  barracks INTEGER NOT NULL DEFAULT 1,
  storage INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS territories (
  id VARCHAR(8) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  owner_faction VARCHAR(16) NOT NULL DEFAULT 'neutral',
  defense_troops INTEGER NOT NULL DEFAULT 0,
  bonus_type VARCHAR(32) NOT NULL DEFAULT 'none',
  bonus_value NUMERIC(6, 3) NOT NULL DEFAULT 0,
  is_fortress BOOLEAN NOT NULL DEFAULT FALSE,
  is_capital BOOLEAN NOT NULL DEFAULT FALSE,
  resource_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0,
  storage_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_battle_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS territory_neighbors (
  territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  neighbor_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  PRIMARY KEY (territory_id, neighbor_id)
);

CREATE TABLE IF NOT EXISTS territory_defenders (
  territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  faction VARCHAR(16) NOT NULL,
  troops INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (territory_id, player_id)
);

CREATE TABLE IF NOT EXISTS attack_contributions (
  id SERIAL PRIMARY KEY,
  territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  contribution INTEGER NOT NULL DEFAULT 0,
  faction VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (territory_id, player_id)
);

CREATE TABLE IF NOT EXISTS battle_history (
  id SERIAL PRIMARY KEY,
  attacker_faction VARCHAR(16) NOT NULL,
  defender_faction VARCHAR(16) NOT NULL,
  territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  attacker_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  troops_sent INTEGER NOT NULL DEFAULT 0,
  defender_total INTEGER NOT NULL DEFAULT 0,
  applied_bonuses TEXT,
  winner VARCHAR(16) NOT NULL,
  attackers_lost INTEGER NOT NULL DEFAULT 0,
  attackers_surviving INTEGER NOT NULL DEFAULT 0,
  defenders_lost INTEGER NOT NULL DEFAULT 0,
  defenders_surviving INTEGER NOT NULL DEFAULT 0,
  owner_before VARCHAR(16) NOT NULL,
  owner_after VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attack_targets (
  id SERIAL PRIMARY KEY,
  faction VARCHAR(16) NOT NULL,
  territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  started_by INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  defender_faction VARCHAR(16) NOT NULL,
  season_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolves_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS faction_leaders (
  faction VARCHAR(16) PRIMARY KEY,
  player_id INTEGER NULL REFERENCES players(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  action_name VARCHAR(64) NOT NULL,
  action_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS faction_chat_messages (
  id SERIAL PRIMARY KEY,
  faction VARCHAR(16) NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  season_number INTEGER UNIQUE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  blue_score INTEGER,
  red_score INTEGER,
  green_score INTEGER,
  result VARCHAR(16),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_season_stats (
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kills INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  battles_joined INTEGER NOT NULL DEFAULT 0,
  battles_won INTEGER NOT NULL DEFAULT 0,
  successful_defences INTEGER NOT NULL DEFAULT 0,
  territories_captured INTEGER NOT NULL DEFAULT 0,
  retakes INTEGER NOT NULL DEFAULT 0,
  reinforcement_troops_sent INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, player_id)
);

CREATE TABLE IF NOT EXISTS season_territory_faction_ownership (
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  faction VARCHAR(16) NOT NULL,
  PRIMARY KEY (season_id, territory_id, faction)
);

CREATE INDEX IF NOT EXISTS idx_players_username ON players(username);
CREATE INDEX IF NOT EXISTS idx_buildings_player ON buildings(player_id);
CREATE INDEX IF NOT EXISTS idx_attack_contrib_territory ON attack_contributions(territory_id);
CREATE UNIQUE INDEX IF NOT EXISTS attack_targets_territory_idx ON attack_targets(territory_id);
CREATE INDEX IF NOT EXISTS idx_attack_targets_due ON attack_targets(resolves_at, id);
CREATE INDEX IF NOT EXISTS idx_defenders_territory ON territory_defenders(territory_id);
CREATE INDEX IF NOT EXISTS idx_faction_chat_messages_faction_time ON faction_chat_messages(faction, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_player_season_stats_rankings ON player_season_stats(season_id);
