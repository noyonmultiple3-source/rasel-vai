// src/index.ts — Layer 4/5: Bot entry point, commands, health checks, graceful shutdown
import { Telegraf } from 'telegraf';
import http from 'http';
import { config, isAdminId } from './config.js';
import { initDb, isDbAvailable, isBotPaused, pool } from './db.js';
import { bawAvailable, getBawBinPath } from './wallet.js';
import { ADDR, REFERRER_NAME } from './bsc.js';
import { logger } from './logger.js';

import { handleStart }         from './handlers/start.js';
import { handleConnectWallet } from './handlers/wallet.js';
import { handleGenerateQr }    from './handlers/qr.js';
import { handleCompleteProcess } from './handlers/execute.js';
import { handleMyJobs }        from './handlers/jobs.js';
import { handleCancel }        from './handlers/cancel.js';
import {
  handleAdminOverview,
  handleAdminUsers,
  handleAdminCompleted,
  handleAdminIncomplete,
  handleAdminBotStop,
  handleAdminBotStart,
} from './handlers/admin.js';
import { handleMessage }       from './handlers/message.js';

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// ── Global Admin Stop/Start Gate (MUST run before every command, action, and text handler) ──
// When paused by an admin, nothing works for normal users while configured ADMIN_ID(s)
// retain full access to every command, button, and process.
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (isBotPaused() && !isAdminId(userId)) {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Bot is currently stopped by admin.');
      }
    } catch { /* ignore */ }
    try {
      await ctx.reply('⛔ The bot is currently stopped by the administrator. Please try again later.');
    } catch { /* ignore */ }
    return;
  }
  return next();
});

// ── Commands ─────────────────────────────────────────────────────────────────
bot.start(handleStart);
bot.command('connect',          handleConnectWallet);   // /connect alias
bot.command('mint',             handleCompleteProcess); // /mint alias
bot.command('status',           handleMyJobs);          // Personal status & incomplete/completed counts
bot.command('my_jobs',          handleMyJobs);          // Personal status alias

// Admin-only commands (strictly gated by config.ADMIN_IDS inside handlers)
bot.command('admin',            handleAdminOverview);
bot.command('admin_users',      handleAdminUsers);
bot.command('admin_completed',  handleAdminCompleted);
bot.command('admin_incomplete', handleAdminIncomplete);
bot.command('admin_stop',       handleAdminBotStop);
bot.command('stop_bot',         handleAdminBotStop);
bot.command('admin_start',      handleAdminBotStart);
bot.command('start_bot',        handleAdminBotStart);

// ── Inline button handlers ───────────────────────────────────────────────────
bot.action('connect_wallet',   handleConnectWallet);
bot.action('generate_qr',      handleGenerateQr);
bot.action('complete_process', handleCompleteProcess);
bot.action('my_jobs',          handleMyJobs);
bot.action('cancel',           handleCancel);

// Admin-only inline button callbacks (strictly gated inside handlers)
bot.action('admin_overview',   handleAdminOverview);
bot.action('admin_users',      handleAdminUsers);
bot.action('admin_completed',  handleAdminCompleted);
bot.action('admin_incomplete', handleAdminIncomplete);
bot.action('admin_bot_stop',   handleAdminBotStop);
bot.action('admin_bot_start',  handleAdminBotStart);

// ── Free-text NL routing (Gemini intent, free-tier-safe) ─────────────────────
bot.on('text', handleMessage);

// ── Global error handler ─────────────────────────────────────────────────────
bot.catch((err: unknown, ctx) => {
  logger.error({ err, updateType: ctx.updateType }, 'Telegraf error');
});

// ── Health check server (Railway / Render / Docker / local) ──────────────────
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      botMode: isBotPaused() ? 'stopped_admin_only' : 'running',
      db: isDbAvailable() ? 'connected' : 'degraded',
      baw: bawAvailable() ? 'ready' : 'missing',
      uptime: Math.floor(process.uptime()),
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.info(
    {
      port: config.PORT,
      adminCount: config.ADMIN_IDS.length,
      bawReady: bawAvailable(),
      bawSessionRoot: config.BAW_SESSION_ROOT,
      referrer: `${REFERRER_NAME} (${ADDR.REFERRER})`,
    },
    'Starting BNB Telegram Bot…',
  );

  if (!bawAvailable()) {
    logger.warn(
      { expectedPath: getBawBinPath() },
      '@binance/agentic-wallet CLI binary not found — run "npm ci" before pairing/execution',
    );
  }

  // DB init is non-fatal — bot starts in degraded mode if Supabase is unreachable
  try {
    await initDb();
  } catch (err) {
    const e = err as Error;
    logger.error(
      { msg: e.message, stack: e.stack, cause: (e as NodeJS.ErrnoException).code },
      'DB init failed — starting in degraded mode (no DB persistence until reconnected)',
    );
  }

  healthServer.listen(config.PORT, () =>
    logger.info({ port: config.PORT }, 'Health server listening'),
  );
  await bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  logger.info('Bot running (long polling)');
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down…');
  bot.stop(signal);
  healthServer.close(() =>
    pool.end().then(() => {
      logger.info('DB closed. Bye.');
      process.exit(0);
    }),
  );
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
main().catch((err) => {
  const e = err as Error;
  console.error('FATAL STARTUP ERROR:', e?.message ?? e);
  console.error('Stack:', e?.stack);
  console.error('Cause:', (e as NodeJS.ErrnoException)?.code ?? (e as Error & { cause?: unknown })?.cause);
  process.exit(1);
});
