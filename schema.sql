-- ============================================================
-- Binance Agentic TG Bot — Supabase / PostgreSQL Schema
-- Run this once against your Supabase project using:
--   psql "$SUPABASE_DB_URL" -f schema.sql
-- or paste it into the Supabase SQL Editor.
-- ============================================================

-- ── Users ─────────────────────────────────────────────────────────────────────
-- One row per Telegram user. Tracks wallet connection state, bound Agent ID,
-- wallet address, and completed job count.

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id    BIGINT      PRIMARY KEY,
  username            TEXT,
  first_name          TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_step        TEXT        NOT NULL DEFAULT 'start',
  -- current_step values:
  --   start | connecting | qr_shown | connected | executing | completed | failed | cancelled
  session_link        TEXT,       -- Pairing deep-link URI from @binance/agentic-wallet (baw)
  qr_generated        BOOLEAN     NOT NULL DEFAULT FALSE,
  is_wallet_connected BOOLEAN     NOT NULL DEFAULT FALSE,  -- TRUE only after markSessionConnected() succeeds
  wallet_address      TEXT,       -- Bound BSC 0x wallet address from baw
  agent_id_name       TEXT,       -- Bound SPACE ID *.ai Agent ID (if claimed)
  is_cancelled        BOOLEAN     NOT NULL DEFAULT FALSE,
  completed_count     INT         NOT NULL DEFAULT 0
);

-- Safe migrations for existing deployments (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_link TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id_name TEXT;

-- Indexes for admin & status queries
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_completed   ON users (completed_count DESC) WHERE completed_count > 0;
CREATE INDEX IF NOT EXISTS idx_users_connected   ON users (is_wallet_connected) WHERE is_wallet_connected = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_agent_id    ON users (agent_id_name) WHERE agent_id_name IS NOT NULL;

-- ── Executions ────────────────────────────────────────────────────────────────
-- One row per mint/approve/sell pipeline attempt (COMPLETED, STOPPED, FAILED, CANCELLED).

CREATE TABLE IF NOT EXISTS executions (
  id               BIGSERIAL   PRIMARY KEY,
  telegram_user_id BIGINT      NOT NULL REFERENCES users (telegram_user_id) ON DELETE CASCADE,
  wallet_address   TEXT,                       -- Bound BSC 0x wallet address for one-time completed ID lock
  agent_id_name    TEXT,                       -- *.ai SPACE ID name, or wallet address fallback
  status           TEXT        NOT NULL,       -- COMPLETED | STOPPED | CANCELLED | FAILED
  mint_cost_bnb    NUMERIC(30, 18),            -- BNB spent on mint (exact wei→ether)
  tokens_received  NUMERIC(30, 18),            -- AI tokens received after mint
  sell_bnb         NUMERIC(30, 18),            -- BNB received from PancakeSwap sell
  pnl_or_fee       NUMERIC(30, 18),            -- sell_bnb − mint_cost_bnb (negative = loss)
  tx_hashes        JSONB,                      -- { "mint": "0x...", "approve": "0x...", "sell": "0x..." }
  summary          TEXT,                       -- AI-generated summary or stop/failure reason
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe migration for existing deployments
ALTER TABLE executions ADD COLUMN IF NOT EXISTS wallet_address TEXT;

CREATE INDEX IF NOT EXISTS idx_executions_user            ON executions (telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status          ON executions (status);
CREATE INDEX IF NOT EXISTS idx_executions_agent           ON executions (agent_id_name) WHERE agent_id_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_completed_agent ON executions (LOWER(agent_id_name)) WHERE status = 'COMPLETED' AND agent_id_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_completed_addr  ON executions (LOWER(wallet_address)) WHERE status = 'COMPLETED' AND wallet_address IS NOT NULL;

-- ── Bot Settings ──────────────────────────────────────────────────────────────
-- Durable key-value runtime flags (e.g. admin-only bot_paused state).

CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
