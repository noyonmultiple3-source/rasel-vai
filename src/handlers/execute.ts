// src/handlers/execute.ts — Layer 4: /mint handler with live single-message updates
import { Context } from 'telegraf';
import { isSessionConnectedDb, getSession } from '../wallet.js';
import { isUserLocked, runFullExecution, ALREADY_COMPLETED_MESSAGE } from '../executor.js';
import { checkWalletReferralEligibility, OTHER_REFERRER_INELIGIBLE_MESSAGE } from '../bsc.js';
import {
  safeUpdateUser,
  getUser,
  hasCompletedCycleForAgent,
  getLatestUnfinishedMint,
} from '../db.js';
import { KB } from '../keyboards.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

export async function handleCompleteProcess(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Starting…');

  // Guard 1: wallet must be connected — check Supabase (survives restarts)
  const { connected, address, dbAgentId } = await isSessionConnectedDb(userId);
  if (!connected) {
    await ctx.reply(
      '⚠️ Wallet not connected.\n\n' +
      'Steps:\n1. Tap Connect Your Binance Wallet\n2. Scan the QR code in the Binance app\n' +
      '3. Wait for confirmation, then tap Complete All Process.',
      KB.start,
    );
    return;
  }

  // Guard 2: One-time completed lock strictly by Agent ID (*.ai) / Agent Wallet (NOT Telegram userId)
  const memSession = getSession(userId);
  const knownAgentId = memSession?.agentIdName ?? dbAgentId ?? null;
  const completedCheck = await hasCompletedCycleForAgent({
    agentIdName: knownAgentId,
    walletAddress: address ?? null,
  });
  if (completedCheck.completed) {
    logger.info(
      { userId, matchedBy: completedCheck.matchedBy, knownAgentId, address: address ?? null },
      'Blocked Complete All Process: Agent ID / Agent Wallet already completed a full cycle',
    );
    await ctx.reply(ALREADY_COMPLETED_MESSAGE, KB.postExecution);
    return;
  }

  // Guard 3: Authoritative on-chain referral & prior-completion check (catches wallets completed
  // under another referrer even when not present in our local database)
  if (address) {
    const unfinishedMint = await getLatestUnfinishedMint(userId, address);
    const referralCheck = await checkWalletReferralEligibility(address, {
      hasLocalUnfinishedMint: Boolean(unfinishedMint),
    });
    if (!referralCheck.eligible) {
      if (referralCheck.reasonCode === 'OTHER_REFERRER') {
        await ctx.reply(OTHER_REFERRER_INELIGIBLE_MESSAGE, KB.start);
        return;
      }
      if (referralCheck.reasonCode === 'ALREADY_COMPLETED_OWN_REFERRER') {
        await ctx.reply(ALREADY_COMPLETED_MESSAGE, KB.postExecution);
        return;
      }
    }
  }

  if (isUserLocked(userId)) {
    await ctx.reply('⏳ A job is already running. Please wait or tap Cancel.', KB.cancelOnly);
    return;
  }

  // Send the SINGLE status message we will edit throughout the cycle
  const statusMsg = await ctx.reply(
    '⚙️ Work has started. Please wait until all steps are completed.\n\n' +
    '🔍 Verifying wallet connection…',
    KB.cancelOnly,
  );

  const chatId    = statusMsg.chat.id;
  const messageId = statusMsg.message_id;

  /** Edits the single live-status message in place */
  const onStatus = async (text: string): Promise<void> => {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
        reply_markup: KB.cancelOnly.reply_markup,
      });
    } catch { /* message may already be deleted or identical — ignore */ }
  };

  await safeUpdateUser(userId, { current_step: 'executing' });

  // Run asynchronously so the bot stays responsive
  runFullExecution(userId, onStatus)
    .then(async (result) => {
      if (result.ok) {
        await safeUpdateUser(userId, { current_step: 'completed' });
        await notifyAdmin(ctx, userId, result.agentId, result);
        // Replace live status with final clean report
        await ctx.telegram.editMessageText(chatId, messageId, undefined, result.summary, {
          reply_markup: KB.postExecution.reply_markup,
        });
      } else if (result.ineligibleOtherReferrer) {
        await safeUpdateUser(userId, { current_step: 'failed' });
        await ctx.telegram.editMessageText(chatId, messageId, undefined, OTHER_REFERRER_INELIGIBLE_MESSAGE, {
          reply_markup: KB.start.reply_markup,
        });
      } else if (result.alreadyCompleted) {
        await safeUpdateUser(userId, { current_step: 'completed' });
        await ctx.telegram.editMessageText(chatId, messageId, undefined, ALREADY_COMPLETED_MESSAGE, {
          reply_markup: KB.postExecution.reply_markup,
        });
      } else {
        await safeUpdateUser(userId, { current_step: result.isSessionExpired ? 'connecting' : 'failed' });

        const partialInfo = result.partialTxHashes
          ? Object.entries(result.partialTxHashes).map(([k, v]) => `  ${k}: ${v}`).join('\n')
          : '';
        const msg =
          `❌ Process stopped\n\n${result.reason}` +
          (partialInfo ? `\n\nBroadcast TXs:\n${partialInfo}` : '') +
          (result.isSessionExpired
            ? '\n\nTap Connect Your Binance Wallet to reconnect.' : '');

        await ctx.telegram.editMessageText(chatId, messageId, undefined, msg, {
          reply_markup: (result.isSessionExpired ? KB.start : KB.postExecution).reply_markup,
        });
      }
    })
    .catch(async (err: Error) => {
      logger.error({ err, userId }, 'Unexpected error in runFullExecution');
      await ctx.telegram.editMessageText(chatId, messageId, undefined,
        `❌ Unexpected error: ${err.message}`, { reply_markup: KB.postExecution.reply_markup });
    });
}

async function notifyAdmin(
  ctx: Context,
  userId: number,
  agentId: string,
  result: { mintCostBnb: string; sellBnb: string; pnlOrFee: string; mintTxHash: string },
): Promise<void> {
  let user = null;
  try {
    user = await getUser(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'notifyAdmin: failed to load user record');
  }

  const name = user?.first_name ?? user?.username ?? String(userId);
  // Note: executor.logExecution already incremented completed_count before returning ok=true.
  const totalCompleted = user?.completed_count ?? 1;
  const text =
    `✅ Job Completed\n\n` +
    `User: ${name} (ID: ${userId})\n` +
    `Agent ID: ${agentId}\n` +
    `Mint cost: ${result.mintCostBnb} BNB\n` +
    `Sell: ${result.sellBnb} BNB\n` +
    `PnL: ${result.pnlOrFee} BNB\n` +
    `Mint TX: ${result.mintTxHash}\n` +
    `Total completed by user: ${totalCompleted}`;

  for (const adminId of config.ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(adminId, text);
    } catch (err) {
      logger.warn({ err, adminId }, 'Failed to notify admin');
    }
  }
}
