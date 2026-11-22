// src/handlers/admin.ts
// Admin-only commands & inline dashboard views.
// Strictly restricted to configured ADMIN_ID(s) — never exposed to normal users.

import { Context } from 'telegraf';
import {
  getAdminOverviewStats,
  getAllStartedUsers,
  getCompletedUsers,
  getIncompleteUsers,
  isBotPaused,
  setBotPaused,
} from '../db.js';
import { cancelAllNonAdminExecutions } from '../executor.js';
import { isAdminId } from '../config.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

const TELEGRAM_MAX_LEN = 3900;

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

async function guardAdmin(ctx: Context): Promise<boolean> {
  if (!isAdminId(ctx.from?.id)) {
    await safeAnswerCb(ctx, 'Unauthorized');
    await ctx.reply('⛔ Unauthorized. This command is restricted to bot administrators.');
    return false;
  }
  return true;
}

/** Sends plain text safely under Telegram's 4096-character limit. */
async function replyChunked(
  ctx: Context,
  text: string,
  withAdminMenu = true,
): Promise<void> {
  if (text.length <= TELEGRAM_MAX_LEN) {
    await ctx.reply(text, withAdminMenu ? KB.adminMenu : undefined);
    return;
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > TELEGRAM_MAX_LEN && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await ctx.reply(chunks[i], isLast && withAdminMenu ? KB.adminMenu : undefined);
  }
}

async function replyDbDegraded(ctx: Context, action: string, err: unknown): Promise<void> {
  logger.error({ err, action }, 'Admin query failed (DB degraded)');
  await ctx.reply(
    '⚠️ Database is currently unavailable (degraded mode).\n\n' +
    'Could not load admin analytics from Supabase/PostgreSQL. ' +
    'Verify SUPABASE_DB_URL and database connectivity in server logs.',
    KB.adminMenu,
  );
}

function formatUserLabel(u: { first_name: string | null; username: string | null; telegram_user_id: number }): string {
  const parts: string[] = [];
  if (u.first_name) parts.push(u.first_name);
  if (u.username) parts.push(`@${u.username}`);
  const label = parts.length > 0 ? parts.join(' ') : String(u.telegram_user_id);
  return `${label} (ID: ${u.telegram_user_id})`;
}

/** /admin — full overview across all users, completed Agent IDs, and incomplete/connected-only accounts */
export async function handleAdminOverview(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading admin overview…');

  try {
    const stats = await getAdminOverviewStats();
    const incompleteRunsTotal =
      stats.stoppedRunsTotal + stats.failedRunsTotal + stats.cancelledRunsTotal;

    const previewAgents = stats.uniqueCompletedAgentIds.slice(0, 15);
    const agentSection =
      previewAgents.length > 0
        ? [
            `🤖 Completed Agent IDs (${stats.uniqueCompletedAgentIds.length} unique):`,
            ...previewAgents.map((a) => `  • ${a}`),
            ...(stats.uniqueCompletedAgentIds.length > previewAgents.length
              ? [`  … and ${stats.uniqueCompletedAgentIds.length - previewAgents.length} more (use /admin_completed)`]
              : []),
          ]
        : ['🤖 Completed Agent IDs: none yet'];

    const botStatusLine = isBotPaused()
      ? '🔴 STOPPED (Admin-Only Mode — normal users blocked)'
      : '🟢 RUNNING (Active for all users)';

    const lines = [
      `🛡️ Admin Dashboard Overview`,
      `Status: ${botStatusLine}`,
      ``,
      `👥 Users:`,
      `  • Total started: ${stats.totalUsers}`,
      `  • Wallet connected: ${stats.connectedUsers}`,
      `  • Completed full cycle: ${stats.completedUsersCount}`,
      `  • Connected only (0 completed): ${stats.connectedOnlyUsersCount}`,
      `  • Connected / Incomplete / Failed: ${stats.incompleteUsersCount}`,
      ``,
      `📈 Full Cycles (mint + approve + sell):`,
      `  • Total completed runs: ${stats.completedCyclesTotal}`,
      `  • Unique completed Agent IDs: ${stats.uniqueCompletedAgentIds.length}`,
      ``,
      `⚠️ Non-Completed Attempts (${incompleteRunsTotal} total):`,
      `  • Stopped (preflight / guard): ${stats.stoppedRunsTotal}`,
      `  • Failed (session expired / RPC / congestion): ${stats.failedRunsTotal}`,
      `  • Cancelled: ${stats.cancelledRunsTotal}`,
      ``,
      ...agentSection,
      ``,
      `Commands: /admin | /admin_completed | /admin_incomplete | /admin_users | /admin_stop | /admin_start`,
    ];

    await replyChunked(ctx, lines.join('\n'), true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_overview', err);
  }
}

/** /admin_completed — total count & full list of Agent IDs and users that completed mint + approve + sell */
export async function handleAdminCompleted(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading completed records…');

  try {
    const users = await getCompletedUsers();
    if (users.length === 0) {
      await ctx.reply('🏆 Completed Full Cycles (0)\n\nNo Agent IDs have completed the full cycle yet.', KB.adminMenu);
      return;
    }

    const allCompletedAgents = new Set<string>();
    let totalCycles = 0;

    const entries = users.map((u, i) => {
      const cycles = Math.max(u.completed_count, u.completed_exec_count);
      totalCycles += cycles;

      const userAgents = new Set<string>(u.agent_ids);
      if (userAgents.size === 0 && u.agent_id_name) userAgents.add(u.agent_id_name);
      if (userAgents.size === 0 && u.wallet_address) userAgents.add(u.wallet_address);
      for (const a of userAgents) allCompletedAgents.add(a);

      const agentList = userAgents.size > 0 ? [...userAgents].join(', ') : 'unknown';
      const walletLine = u.wallet_address ? `\n    💳 Wallet: ${u.wallet_address}` : '';
      const incNote = u.incomplete_count > 0 ? ` | ⚠️ ${u.incomplete_count} incomplete` : '';

      return (
        `${i + 1}. ${formatUserLabel(u)}\n` +
        `    ✅ Completed cycles: ${cycles}${incNote}\n` +
        `    🤖 Agent ID(s): ${agentList}` +
        walletLine
      );
    });

    const header = [
      `🏆 Completed Full Cycles (mint + approve + sell)`,
      ``,
      `• Completed Users: ${users.length}`,
      `• Unique Completed Agent IDs: ${allCompletedAgents.size}`,
      `• Total Completed Cycles: ${totalCycles}`,
      ``,
    ].join('\n');

    await replyChunked(ctx, header + entries.join('\n\n'), true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_completed', err);
  }
}

/** /admin_incomplete — connected-only wallets & users/Agent IDs that did not complete the cycle */
export async function handleAdminIncomplete(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading incomplete records…');

  try {
    const records = await getIncompleteUsers();
    if (records.length === 0) {
      await ctx.reply(
        '⚠️ Connected / Incomplete Accounts (0)\n\nNo connected-only or incomplete/failed accounts found.',
        KB.adminMenu,
      );
      return;
    }

    const connectedOnlyCount = records.filter((r) => r.is_wallet_connected && r.completed_count === 0).length;
    const withIncompleteRuns = records.filter((r) => r.incomplete_count > 0).length;

    const entries = records.map((r, i) => {
      const boundIds = new Set<string>();
      if (r.agent_id_name) boundIds.add(r.agent_id_name);
      for (const a of r.incomplete_agent_ids) boundIds.add(a);
      const agentDisplay = boundIds.size > 0
        ? [...boundIds].join(', ')
        : (r.wallet_address ?? 'not bound yet');

      const stateTag =
        r.is_wallet_connected && r.completed_count === 0 && r.incomplete_count === 0
          ? 'Connected only (no run started)'
          : `Step: ${r.current_step} | Wallet: ${r.is_wallet_connected ? 'connected' : 'not connected'}`;

      const breakdownParts: string[] = [];
      if (r.stopped_count > 0) breakdownParts.push(`stopped=${r.stopped_count}`);
      if (r.failed_count > 0) breakdownParts.push(`failed=${r.failed_count}`);
      if (r.cancelled_count > 0) breakdownParts.push(`cancelled=${r.cancelled_count}`);
      const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : '';

      const reasonLine = r.last_incomplete_reason
        ? `\n    📝 Last ${r.last_incomplete_status ?? 'INCOMPLETE'}: ${r.last_incomplete_reason.slice(0, 140)}`
        : '';

      const walletLine =
        r.wallet_address && r.wallet_address !== agentDisplay
          ? `\n    💳 Wallet: ${r.wallet_address}`
          : '';

      return (
        `${i + 1}. ${formatUserLabel(r)}\n` +
        `    🤖 Agent ID / Wallet: ${agentDisplay}${walletLine}\n` +
        `    📍 ${stateTag}\n` +
        `    ✅ Completed: ${r.completed_count} | ⚠️ Incomplete runs: ${r.incomplete_count}${breakdown}` +
        reasonLine
      );
    });

    const header = [
      `⚠️ Connected-Only & Incomplete Accounts`,
      ``,
      `• Total flagged accounts: ${records.length}`,
      `• Connected only (0 completed): ${connectedOnlyCount}`,
      `• Accounts with failed/stopped/cancelled runs: ${withIncompleteRuns}`,
      ``,
    ].join('\n');

    await replyChunked(ctx, header + entries.join('\n\n'), true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_incomplete', err);
  }
}

/** /admin_users — list all users who started the bot with connection & completion stats */
export async function handleAdminUsers(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Loading all users…');

  try {
    const users = await getAllStartedUsers();
    if (users.length === 0) {
      await ctx.reply('👥 All Users (0)\n\nNo users yet.', KB.adminMenu);
      return;
    }

    const lines = users.slice(0, 100).map((u, i) => {
      const date = new Date(u.started_at).toISOString().slice(0, 10);
      const conn = u.is_wallet_connected ? '🟢 connected' : '⚪ not connected';
      const agent = u.agent_id_name ?? (u.wallet_address ? `${u.wallet_address.slice(0, 8)}…` : 'no agent');
      return (
        `${i + 1}. ${formatUserLabel(u)}\n` +
        `    ${conn} | 🤖 ${agent} | step=${u.current_step}\n` +
        `    ✅ ${u.completed_count} completed | ⚠️ ${u.incomplete_count} incomplete | joined ${date}`
      );
    });

    const footer = users.length > 100 ? `\n\n… and ${users.length - 100} more users` : '';
    await replyChunked(ctx, `👥 All Users (${users.length} total)\n\n${lines.join('\n\n')}${footer}`, true);
  } catch (err) {
    await replyDbDegraded(ctx, 'admin_users', err);
  }
}

/** /admin_stop (and /stop_bot) — pauses bot for all normal users; admin retains full access */
export async function handleAdminBotStop(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Stopping bot for users…');

  const { persisted } = await setBotPaused(true);
  const cancelledActive = cancelAllNonAdminExecutions();

  await ctx.reply(
    `🔴 Bot STOPPED for all normal users.\n\n` +
    `• Normal users: all commands, buttons, and processes are now blocked.\n` +
    `• Admin access: still fully active for configured ADMIN_ID(s).\n` +
    (cancelledActive > 0 ? `• Active non-admin jobs cancelled: ${cancelledActive}\n` : '') +
    `• Persistence: ${persisted ? 'Saved to database (survives restarts)' : 'Active in memory (DB degraded)'}\n\n` +
    `Use /admin_start or tap "▶️ Start Bot (Users)" to re-enable the bot for everyone.`,
    KB.adminMenu,
  );
}

/** /admin_start (and /start_bot) — re-enables the bot for all users */
export async function handleAdminBotStart(ctx: Context): Promise<void> {
  if (!(await guardAdmin(ctx))) return;
  await safeAnswerCb(ctx, 'Starting bot for users…');

  const { persisted } = await setBotPaused(false);

  await ctx.reply(
    `🟢 Bot STARTED and active for everyone.\n\n` +
    `• Normal users: all commands, buttons, and processes are enabled again.\n` +
    `• Persistence: ${persisted ? 'Saved to database (survives restarts)' : 'Active in memory (DB degraded)'}`,
    KB.adminMenu,
  );
}
