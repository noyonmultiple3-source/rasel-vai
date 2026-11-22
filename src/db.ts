// src/db.ts
// Supabase / PostgreSQL client, portable SSL config, schema bootstrap,
// and user/admin queries.

import { Pool, PoolConfig } from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

function buildPoolConfig(connectionString: string): PoolConfig {
  let useSsl = false;
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname.toLowerCase();
    const sslMode = (parsed.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? '').toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (sslMode === 'disable') {
      useSsl = false;
    } else if (!isLocal) {
      // Cloud PostgreSQL providers (Supabase, Railway, Render) require SSL on remote connections.
      useSsl = true;
    }
  } catch {
    // Non-URL connection string — let pg parse it directly.
  }

  return {
    connectionString,
    connectionTimeoutMillis: 10_000,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export const pool = new Pool(buildPoolConfig(config.SUPABASE_DB_URL));

let dbReady = false;
let botPausedCache = false;

export function isDbAvailable(): boolean {
  return dbReady;
}

/** Returns whether the admin has stopped the bot for normal users (admin retains full access). */
export function isBotPaused(): boolean {
  return botPausedCache;
}

/** Reloads persisted `bot_paused` state from PostgreSQL/Supabase. */
export async function loadBotPausedState(): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM bot_settings WHERE key = 'bot_paused' LIMIT 1`,
    );
    dbReady = true;
    botPausedCache = rows[0]?.value === 'true';
    return botPausedCache;
  } catch (err) {
    logger.warn({ err }, 'loadBotPausedState failed — using in-memory botPausedCache');
    return botPausedCache;
  }
}

/** Persists admin bot stop/start state to `bot_settings` and updates in-memory cache immediately. */
export async function setBotPaused(
  paused: boolean,
): Promise<{ paused: boolean; persisted: boolean }> {
  botPausedCache = paused;
  try {
    await pool.query(
      `INSERT INTO bot_settings (key, value, updated_at)
       VALUES ('bot_paused', $1, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = now()`,
      [paused ? 'true' : 'false'],
    );
    dbReady = true;
    logger.info({ botPaused: paused }, 'Updated bot_paused state in database');
    return { paused, persisted: true };
  } catch (err) {
    logger.warn({ err, botPaused: paused }, 'setBotPaused: DB write failed (applied in memory)');
    return { paused, persisted: false };
  }
}

pool.on('error', (err) => {
  dbReady = false;
  logger.error({ err }, 'Unexpected DB pool error');
});

// ─── Schema Bootstrap ───────────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id    BIGINT PRIMARY KEY,
        username            TEXT,
        first_name          TEXT,
        started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        current_step        TEXT NOT NULL DEFAULT 'start',
        session_link        TEXT,
        qr_generated        BOOLEAN NOT NULL DEFAULT FALSE,
        is_wallet_connected BOOLEAN NOT NULL DEFAULT FALSE,
        wallet_address      TEXT,
        agent_id_name       TEXT,
        is_cancelled        BOOLEAN NOT NULL DEFAULT FALSE,
        completed_count     INT NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS executions (
        id               BIGSERIAL PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
        wallet_address   TEXT,
        agent_id_name    TEXT,
        status           TEXT NOT NULL,
        mint_cost_bnb    NUMERIC,
        tokens_received  NUMERIC,
        sell_bnb         NUMERIC,
        pnl_or_fee       NUMERIC,
        tx_hashes        JSONB,
        summary          TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Safe idempotent migrations for deployments created on earlier schema versions
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_link TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_generated BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id_name TEXT`);
    await client.query(`ALTER TABLE executions ADD COLUMN IF NOT EXISTS wallet_address TEXT`);

    // Durable key-value settings (e.g. admin-only bot_paused flag)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Load persisted bot_paused state so admin stop/start survives restarts
    const pauseRes = await client.query<{ value: string }>(
      `SELECT value FROM bot_settings WHERE key = 'bot_paused' LIMIT 1`,
    );
    botPausedCache = pauseRes.rows[0]?.value === 'true';

    dbReady = true;
    logger.info({ botPaused: botPausedCache }, 'Database schema ready');
  } catch (err) {
    dbReady = false;
    throw err;
  } finally {
    client.release();
  }
}

// ─── User helpers ────────────────────────────────────────────────────────────

export interface DbUser {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  started_at: Date;
  last_active_at: Date;
  current_step: string;
  session_link: string | null;
  qr_generated: boolean;
  is_wallet_connected: boolean;
  wallet_address: string | null;
  agent_id_name: string | null;
  is_cancelled: boolean;
  completed_count: number;
}

export async function upsertUser(
  userId: number,
  username: string | null,
  firstName: string | null,
): Promise<DbUser> {
  const { rows } = await pool.query<DbUser>(
    `INSERT INTO users (telegram_user_id, username, first_name, last_active_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET username       = EXCLUDED.username,
           first_name     = EXCLUDED.first_name,
           last_active_at = now(),
           is_cancelled   = FALSE
     RETURNING *`,
    [userId, username, firstName],
  );
  dbReady = true;
  return rows[0];
}

export async function getUser(userId: number): Promise<DbUser | null> {
  const { rows } = await pool.query<DbUser>(
    'SELECT * FROM users WHERE telegram_user_id = $1',
    [userId],
  );
  dbReady = true;
  return rows[0] ?? null;
}

const ALLOWED_USER_UPDATE_FIELDS = new Set<string>([
  'username',
  'first_name',
  'last_active_at',
  'current_step',
  'session_link',
  'qr_generated',
  'is_wallet_connected',
  'wallet_address',
  'agent_id_name',
  'is_cancelled',
  'completed_count',
]);

export async function updateUser(
  userId: number,
  fields: Partial<Omit<DbUser, 'telegram_user_id' | 'started_at'>>,
): Promise<void> {
  const keys = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) =>
    ALLOWED_USER_UPDATE_FIELDS.has(String(k)),
  );
  if (keys.length === 0) return;
  const setClause = keys
    .map((k, i) => `${String(k)} = $${i + 2}`)
    .join(', ');
  await pool.query(
    `UPDATE users SET ${setClause}, last_active_at = now() WHERE telegram_user_id = $1`,
    [userId, ...keys.map((k) => fields[k])],
  );
  dbReady = true;
}

export async function safeUpdateUser(
  userId: number,
  fields: Partial<Omit<DbUser, 'telegram_user_id' | 'started_at'>>,
): Promise<void> {
  try {
    await updateUser(userId, fields);
  } catch (err) {
    logger.warn({ err, userId, fields: Object.keys(fields) }, 'safeUpdateUser failed (degraded DB)');
  }
}

export async function cancelUser(userId: number): Promise<void> {
  await pool.query(
    `UPDATE users SET is_cancelled = TRUE, current_step = 'cancelled', last_active_at = now()
     WHERE telegram_user_id = $1`,
    [userId],
  );
  dbReady = true;
}

// ─── Execution helpers ───────────────────────────────────────────────────────

export interface DbExecution {
  id: number;
  telegram_user_id: number;
  wallet_address?: string | null;
  agent_id_name: string | null;
  status: string;
  mint_cost_bnb: string | null;
  tokens_received: string | null;
  sell_bnb: string | null;
  pnl_or_fee: string | null;
  tx_hashes: Record<string, string> | null;
  summary: string | null;
  created_at: Date;
}

export async function insertExecution(
  data: Omit<DbExecution, 'id' | 'created_at'>,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO executions
       (telegram_user_id, wallet_address, agent_id_name, status, mint_cost_bnb, tokens_received,
        sell_bnb, pnl_or_fee, tx_hashes, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      data.telegram_user_id,
      data.wallet_address ?? null,
      data.agent_id_name,
      data.status,
      data.mint_cost_bnb,
      data.tokens_received,
      data.sell_bnb,
      data.pnl_or_fee,
      data.tx_hashes ? JSON.stringify(data.tx_hashes) : null,
      data.summary,
    ],
  );
  dbReady = true;
  return rows[0].id;
}

// ─── One-time completed Agent ID / Wallet lock (DB-authoritative + memory fallback) ─
// Strictly keyed by normalized agentIdName (*.ai) and/or walletAddress — NEVER by
// telegram_user_id, so one Telegram user can freely run multiple cycles across
// different Agent IDs or different Agent Wallets.

const completedAgentIdsMem = new Set<string>();
const completedWalletsMem  = new Set<string>();

export function recordCompletedAgentInMemory(opts: {
  agentIdName?: string | null;
  walletAddress?: string | null;
}): void {
  const agent = opts.agentIdName?.trim().toLowerCase();
  if (agent) completedAgentIdsMem.add(agent);
  const wallet = opts.walletAddress?.trim().toLowerCase();
  if (wallet) completedWalletsMem.add(wallet);
}

export interface CompletedAgentCheckResult {
  completed: boolean;
  matchedBy?: 'agent_id' | 'wallet_address';
}

/**
 * Checks whether a full cycle (sell confirmed / status = 'COMPLETED') has
 * already finished for this Agent ID (`agentIdName`, e.g. `*.ai`) and/or
 * Agent Wallet (`walletAddress`).
 *
 * Strictly ignores Telegram `userId` (allowing one Telegram account to run
 * different Agent IDs / wallets) and strictly ignores CANCELLED, STOPPED,
 * FAILED, or incomplete mint-only rows so unfinished runs can resume cleanly.
 */
export async function hasCompletedCycleForAgent(opts: {
  agentIdName?: string | null;
  walletAddress?: string | null;
}): Promise<CompletedAgentCheckResult> {
  const agent  = opts.agentIdName?.trim().toLowerCase() || null;
  const wallet = opts.walletAddress?.trim().toLowerCase() || null;

  if (!agent && !wallet) {
    return { completed: false };
  }

  // Fast in-memory check (also protects when DB is temporarily degraded)
  if (agent && completedAgentIdsMem.has(agent)) {
    return { completed: true, matchedBy: 'agent_id' };
  }
  if (wallet && completedWalletsMem.has(wallet)) {
    return { completed: true, matchedBy: 'wallet_address' };
  }

  try {
    // Check genuinely completed execution records (status = 'COMPLETED' with confirmed sell)
    // strictly matching e.agent_id_name or e.wallet_address (never telegram_user_id).
    const { rows } = await pool.query<{
      matched_agent: boolean;
      matched_wallet: boolean;
    }>(
      `SELECT
         BOOL_OR($1::text IS NOT NULL AND LOWER(COALESCE(e.agent_id_name, '')) = $1) AS matched_agent,
         BOOL_OR(
           $2::text IS NOT NULL AND (
             LOWER(COALESCE(e.wallet_address, '')) = $2 OR
             LOWER(COALESCE(e.agent_id_name, '')) = $2
           )
         ) AS matched_wallet
       FROM executions e
       WHERE e.status = 'COMPLETED'
         AND COALESCE(e.tx_hashes->>'sell', '') <> ''
         AND (
           ($1::text IS NOT NULL AND LOWER(COALESCE(e.agent_id_name, '')) = $1)
           OR ($2::text IS NOT NULL AND (
                LOWER(COALESCE(e.wallet_address, '')) = $2 OR
                LOWER(COALESCE(e.agent_id_name, '')) = $2
              ))
         )`,
      [agent, wallet],
    );
    dbReady = true;

    const r = rows[0];
    if (r?.matched_agent) {
      recordCompletedAgentInMemory({ agentIdName: agent });
      return { completed: true, matchedBy: 'agent_id' };
    }
    if (r?.matched_wallet) {
      recordCompletedAgentInMemory({ walletAddress: wallet });
      return { completed: true, matchedBy: 'wallet_address' };
    }

    return { completed: false };
  } catch (err) {
    logger.warn({ err, agent, wallet }, 'hasCompletedCycleForAgent: DB check failed (using in-memory state)');
    return { completed: false };
  }
}

export async function getUserExecutions(
  userId: number,
): Promise<DbExecution[]> {
  const { rows } = await pool.query<DbExecution>(
    `SELECT * FROM executions WHERE telegram_user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  dbReady = true;
  return rows;
}

/**
 * Returns the latest non-completed execution for a user where a mint TX was
 * already broadcast (`tx_hashes->>'mint'` present) but `sell` never completed.
 * Used to resume Approve → Sell instead of blindly re-minting.
 */
export async function getLatestUnfinishedMint(
  userId: number,
  walletAddress?: string | null,
): Promise<DbExecution | null> {
  const wallet = walletAddress?.trim().toLowerCase() || null;
  try {
    const { rows } = await pool.query<DbExecution>(
      `SELECT *
       FROM executions
       WHERE telegram_user_id = $1
         AND status <> 'COMPLETED'
         AND tx_hashes IS NOT NULL
         AND tx_hashes->>'mint' IS NOT NULL
         AND tx_hashes->>'sell' IS NULL
         AND ($2::text IS NULL OR wallet_address IS NULL OR LOWER(wallet_address) = $2)
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, wallet],
    );
    dbReady = true;
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err, userId }, 'getLatestUnfinishedMint failed (continuing with on-chain check)');
    return null;
  }
}

// ─── Admin helpers (NEVER expose to non-admin handlers) ──────────────────────

export interface AdminOverviewStats {
  totalUsers: number;
  connectedUsers: number;
  completedUsersCount: number;
  completedCyclesTotal: number;
  uniqueCompletedAgentIds: string[];
  connectedOnlyUsersCount: number;
  incompleteUsersCount: number;
  stoppedRunsTotal: number;
  failedRunsTotal: number;
  cancelledRunsTotal: number;
}

export interface AdminUserSummary extends DbUser {
  incomplete_count: number;
  stopped_count: number;
  failed_count: number;
  cancelled_count: number;
}

export interface AdminCompletedRecord extends DbUser {
  completed_exec_count: number;
  incomplete_count: number;
  agent_ids: string[];
}

export interface AdminIncompleteRecord extends DbUser {
  incomplete_count: number;
  stopped_count: number;
  failed_count: number;
  cancelled_count: number;
  incomplete_agent_ids: string[];
  last_incomplete_status: string | null;
  last_incomplete_reason: string | null;
  last_incomplete_at: Date | null;
}

export async function getAllStartedUsers(): Promise<AdminUserSummary[]> {
  const { rows } = await pool.query<AdminUserSummary>(
    `SELECT u.*,
            COUNT(e.id) FILTER (WHERE e.status <> 'COMPLETED')::int AS incomplete_count,
            COUNT(e.id) FILTER (WHERE e.status = 'STOPPED')::int    AS stopped_count,
            COUNT(e.id) FILTER (WHERE e.status = 'FAILED')::int     AS failed_count,
            COUNT(e.id) FILTER (WHERE e.status = 'CANCELLED')::int  AS cancelled_count
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
     GROUP BY u.telegram_user_id
     ORDER BY u.started_at DESC`,
  );
  dbReady = true;
  return rows;
}

export async function getCompletedUsers(): Promise<AdminCompletedRecord[]> {
  const { rows } = await pool.query<AdminCompletedRecord>(
    `SELECT u.*,
            COUNT(e.id) FILTER (WHERE e.status = 'COMPLETED')::int  AS completed_exec_count,
            COUNT(e.id) FILTER (WHERE e.status <> 'COMPLETED')::int AS incomplete_count,
            COALESCE(
              array_agg(DISTINCT e.agent_id_name)
                FILTER (WHERE e.status = 'COMPLETED' AND e.agent_id_name IS NOT NULL AND e.agent_id_name <> ''),
              '{}'
            ) AS agent_ids
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
     WHERE u.completed_count > 0
        OR EXISTS (
          SELECT 1 FROM executions ec
          WHERE ec.telegram_user_id = u.telegram_user_id AND ec.status = 'COMPLETED'
        )
     GROUP BY u.telegram_user_id
     ORDER BY GREATEST(u.completed_count, COUNT(e.id) FILTER (WHERE e.status = 'COMPLETED')) DESC,
              u.last_active_at DESC`,
  );
  dbReady = true;
  return rows;
}

export async function getIncompleteUsers(): Promise<AdminIncompleteRecord[]> {
  const { rows } = await pool.query<AdminIncompleteRecord>(
    `SELECT u.*,
            COUNT(e.id) FILTER (WHERE e.status <> 'COMPLETED')::int AS incomplete_count,
            COUNT(e.id) FILTER (WHERE e.status = 'STOPPED')::int    AS stopped_count,
            COUNT(e.id) FILTER (WHERE e.status = 'FAILED')::int     AS failed_count,
            COUNT(e.id) FILTER (WHERE e.status = 'CANCELLED')::int  AS cancelled_count,
            COALESCE(
              array_agg(DISTINCT e.agent_id_name)
                FILTER (WHERE e.status <> 'COMPLETED' AND e.agent_id_name IS NOT NULL AND e.agent_id_name <> ''),
              '{}'
            ) AS incomplete_agent_ids,
            last_inc.status     AS last_incomplete_status,
            last_inc.summary    AS last_incomplete_reason,
            last_inc.created_at AS last_incomplete_at
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
     LEFT JOIN LATERAL (
       SELECT status, summary, created_at
       FROM executions ei
       WHERE ei.telegram_user_id = u.telegram_user_id
         AND ei.status <> 'COMPLETED'
       ORDER BY ei.created_at DESC
       LIMIT 1
     ) last_inc ON TRUE
     WHERE (u.is_wallet_connected = TRUE AND u.completed_count = 0)
        OR u.current_step IN ('connecting', 'qr_shown', 'executing', 'failed', 'cancelled')
        OR EXISTS (
          SELECT 1 FROM executions ex
          WHERE ex.telegram_user_id = u.telegram_user_id AND ex.status <> 'COMPLETED'
        )
     GROUP BY u.telegram_user_id, last_inc.status, last_inc.summary, last_inc.created_at
     ORDER BY last_inc.created_at DESC NULLS LAST, u.last_active_at DESC`,
  );
  dbReady = true;
  return rows;
}

export async function getAdminOverviewStats(): Promise<AdminOverviewStats> {
  const [userCountsRes, execCountsRes, completedAgentsRes] = await Promise.all([
    pool.query<{
      total_users: number;
      connected_users: number;
      completed_users: number;
      connected_only_users: number;
      incomplete_users: number;
    }>(`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE is_wallet_connected = TRUE)::int AS connected_users,
        COUNT(*) FILTER (
          WHERE completed_count > 0
             OR EXISTS (SELECT 1 FROM executions e WHERE e.telegram_user_id = users.telegram_user_id AND e.status = 'COMPLETED')
        )::int AS completed_users,
        COUNT(*) FILTER (WHERE is_wallet_connected = TRUE AND completed_count = 0)::int AS connected_only_users,
        COUNT(*) FILTER (
          WHERE (is_wallet_connected = TRUE AND completed_count = 0)
             OR current_step IN ('connecting', 'qr_shown', 'executing', 'failed', 'cancelled')
             OR EXISTS (SELECT 1 FROM executions e WHERE e.telegram_user_id = users.telegram_user_id AND e.status <> 'COMPLETED')
        )::int AS incomplete_users
      FROM users
    `),
    pool.query<{
      completed_total: number;
      stopped_total: number;
      failed_total: number;
      cancelled_total: number;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_total,
        COUNT(*) FILTER (WHERE status = 'STOPPED')::int   AS stopped_total,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int    AS failed_total,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_total
      FROM executions
    `),
    pool.query<{ agent_id_name: string }>(`
      SELECT DISTINCT agent_id_name
      FROM executions
      WHERE status = 'COMPLETED'
        AND agent_id_name IS NOT NULL
        AND agent_id_name <> ''
      ORDER BY agent_id_name ASC
    `),
  ]);

  dbReady = true;
  const u = userCountsRes.rows[0];
  const e = execCountsRes.rows[0];

  return {
    totalUsers: u?.total_users ?? 0,
    connectedUsers: u?.connected_users ?? 0,
    completedUsersCount: u?.completed_users ?? 0,
    completedCyclesTotal: e?.completed_total ?? 0,
    uniqueCompletedAgentIds: completedAgentsRes.rows.map((r) => r.agent_id_name),
    connectedOnlyUsersCount: u?.connected_only_users ?? 0,
    incompleteUsersCount: u?.incomplete_users ?? 0,
    stoppedRunsTotal: e?.stopped_total ?? 0,
    failedRunsTotal: e?.failed_total ?? 0,
    cancelledRunsTotal: e?.cancelled_total ?? 0,
  };
}
