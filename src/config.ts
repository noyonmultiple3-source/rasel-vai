// src/config.ts
// Environment validation and typed, portable configuration.

import dotenv from 'dotenv';
import * as os from 'os';
import * as path from 'path';

dotenv.config();

function optionalEnv(name: string, fallback = ''): string {
  const val = process.env[name]?.trim();
  return val && val.length > 0 ? val : fallback;
}

function parseAdminIds(rawList: string[]): number[] {
  const ids = new Set<number>();
  for (const raw of rawList) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (!/^\d+$/.test(trimmed)) {
        throw new Error(`Invalid admin ID "${trimmed}" — ADMIN_ID / ADMIN_IDS must contain numeric Telegram user IDs`);
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid admin ID "${trimmed}" — must be a positive integer`);
      }
      ids.add(parsed);
    }
  }
  return [...ids];
}

// Validate all required env vars together so missing setup on a new host is reported in one pass.
const REQUIRED_VARS = [
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_DB_URL',
  'ADMIN_ID',
  'BSC_RPC_URL',
] as const;

const missing = REQUIRED_VARS.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
    `Copy .env.example to .env (or configure them in your host environment) before starting.`,
  );
}

const adminIds = parseAdminIds([
  process.env.ADMIN_ID ?? '',
  process.env.ADMIN_IDS ?? '',
]);

if (adminIds.length === 0) {
  throw new Error('ADMIN_ID must include at least one valid numeric Telegram user ID');
}

const rawPort = optionalEnv('PORT', '3000');
const parsedPort = Number.parseInt(rawPort, 10);
if (Number.isNaN(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
  throw new Error(`Invalid PORT "${rawPort}" — must be an integer between 1 and 65535`);
}

const rawSessionRoot = optionalEnv('BAW_SESSION_ROOT');
const resolvedSessionRoot = rawSessionRoot
  ? path.resolve(rawSessionRoot)
  : path.join(os.homedir(), '.baw-sessions');

export const config = {
  GEMINI_API_KEY:            process.env.GEMINI_API_KEY!.trim(),
  TELEGRAM_BOT_TOKEN:        process.env.TELEGRAM_BOT_TOKEN!.trim(),
  SUPABASE_DB_URL:           process.env.SUPABASE_DB_URL!.trim(),
  SUPABASE_URL:              optionalEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: optionalEnv('SUPABASE_SERVICE_ROLE_KEY'),
  ADMIN_ID:                  adminIds[0],
  ADMIN_IDS:                 adminIds as readonly number[],
  BSC_RPC_URL:               process.env.BSC_RPC_URL!.trim(),
  LOG_LEVEL:                 optionalEnv('LOG_LEVEL', 'info'),
  PORT:                      parsedPort,
  BAW_SESSION_ROOT:          resolvedSessionRoot,
} as const;

export function isAdminId(userId?: number | null): boolean {
  if (typeof userId !== 'number') return false;
  return config.ADMIN_IDS.includes(userId);
}
