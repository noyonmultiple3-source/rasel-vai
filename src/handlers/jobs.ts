// src/handlers/jobs.ts
// Normal user personal status & history view ("My Status & Jobs", /status, /my_jobs).
// Strictly scoped to the requesting user's own telegram_user_id — never exposes other users or admin data.

import { Context } from 'telegraf';
import { getUserExecutions, getUser, DbExecution } from '../db.js';
import { getSession } from '../wallet.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '?';
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return '?';
  }
}

export async function handleMyJobs(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  await safeAnswerCb(ctx, 'Loading your status…');

  const memSession = getSession(userId);

  let user = null;
  let executions: DbExecution[] = [];
  let dbUnavailable = false;

  try {
    [user, executions] = await Promise.all([
      getUser(userId),
      getUserExecutions(userId),
    ]);
  } catch (err) {
    dbUnavailable = true;
    logger.warn({ err, userId }, 'handleMyJobs: DB unavailable — falling back to in-memory session');
  }

  const isConnected = Boolean(user?.is_wallet_connected || memSession?.walletAddress);
  const walletAddr  = memSession?.walletAddress ?? user?.wallet_address ?? null;
  const boundAgent  = memSession?.agentIdName ?? user?.agent_id_name ?? null;

  if (dbUnavailable) {
    const lines = [
      `📊 Your Personal Status`,
      ``,
      `🔗 Wallet: ${isConnected ? 'Connected' : 'Not connected'}`,
      ...(boundAgent ? [`🤖 Bound Agent ID: ${boundAgent}`] : []),
      ...(walletAddr ? [`💳 Wallet Address: ${walletAddr}`] : []),
      ``,
      `⚠️ Job history database is temporarily unreachable. Live session state is shown above; full completed/incomplete counts will appear once the database reconnects.`,
    ];
    await ctx.reply(lines.join('\n'), isConnected ? KB.postExecution : KB.start);
    return;
  }

  const completed  = executions.filter((e) => e.status === 'COMPLETED');
  const incomplete = executions.filter((e) => e.status !== 'COMPLETED');

  const stoppedCount   = incomplete.filter((e) => e.status === 'STOPPED').length;
  const failedCount    = incomplete.filter((e) => e.status === 'FAILED').length;
  const cancelledCount = incomplete.filter((e) => e.status === 'CANCELLED').length;

  const completedAgents = [
    ...new Set(completed.map((e) => e.agent_id_name).filter(Boolean)),
  ] as string[];

  const lines: string[] = [
    `📊 Your Personal Status & Jobs`,
    ``,
    `🔗 Wallet: ${isConnected ? 'Connected' : 'Not connected'}`,
    `🤖 Bound Agent ID: ${boundAgent ?? (completedAgents[0] ?? 'Not bound yet')}`,
    ...(walletAddr ? [`💳 Wallet: ${walletAddr}`] : []),
    ``,
    `✅ Completed full cycles: ${completed.length}`,
  ];

  if (completedAgents.length > 0) {
    lines.push(`🤖 Completed Agent ID(s):`);
    for (const id of completedAgents) {
      lines.push(`  • ${id}`);
    }
  }

  if (completed.length > 0) {
    lines.push(``);
    lines.push(`📋 Recent completed runs (last ${Math.min(5, completed.length)}):`);
    completed.slice(0, 5).forEach((e, i) => {
      lines.push(
        `  ${i + 1}. ${e.agent_id_name ?? '?'} — ` +
        `${e.mint_cost_bnb ?? '?'} BNB → ${e.sell_bnb ?? '?'} BNB (${formatDate(e.created_at)})`,
      );
    });
  }

  lines.push(``);
  lines.push(`⚠️ Incomplete / Not-completed attempts: ${incomplete.length}`);
  if (incomplete.length > 0) {
    const parts: string[] = [];
    if (stoppedCount > 0) parts.push(`Stopped: ${stoppedCount}`);
    if (failedCount > 0) parts.push(`Failed: ${failedCount}`);
    if (cancelledCount > 0) parts.push(`Cancelled: ${cancelledCount}`);
    if (parts.length > 0) {
      lines.push(`  (${parts.join(' | ')})`);
    }

    lines.push(`📝 Recent incomplete attempts (last ${Math.min(5, incomplete.length)}):`);
    incomplete.slice(0, 5).forEach((e, i) => {
      const reason = e.summary ? ` — ${e.summary.slice(0, 100)}` : '';
      lines.push(`  ${i + 1}. [${e.status}] (${formatDate(e.created_at)})${reason}`);
    });
  } else if (completed.length === 0) {
    lines.push(`  You haven't run any mint/sell cycles yet.`);
  }

  await ctx.reply(lines.join('\n'), isConnected ? KB.postExecution : KB.start);
}
