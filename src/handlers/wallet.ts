// src/handlers/wallet.ts — /connect flow with live QR, background verification,
// and immediate on-chain referral/completion eligibility checks.
import { Context } from 'telegraf';
import {
  bawAvailable,
  generatePairingUri,
  verifyAndBindSession,
} from '../wallet.js';
import {
  checkWalletReferralEligibility,
  OTHER_REFERRER_INELIGIBLE_MESSAGE,
} from '../bsc.js';
import { ALREADY_COMPLETED_MESSAGE } from '../executor.js';
import { generateQrBuffer } from '../qr.js';
import {
  safeUpdateUser,
  hasCompletedCycleForAgent,
  getLatestUnfinishedMint,
} from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

/**
 * Checks whether a newly connected / already-connected wallet is blocked either
 * by another referrer on-chain (`OTHER_REFERRER_INELIGIBLE_MESSAGE`) or by prior
 * completion on the same Agent ID / Agent Wallet (`ALREADY_COMPLETED_MESSAGE`).
 */
async function checkConnectedWalletStatus(
  userId: number,
  walletAddress: string,
  agentIdName?: string,
): Promise<{ blocked: true; message: string; keyboard: typeof KB.start } | { blocked: false }> {
  const [unfinishedMint, localCompleted] = await Promise.all([
    getLatestUnfinishedMint(userId, walletAddress),
    hasCompletedCycleForAgent({ agentIdName: agentIdName ?? null, walletAddress }),
  ]);

  const onChainElig = await checkWalletReferralEligibility(walletAddress, {
    hasLocalUnfinishedMint: Boolean(unfinishedMint),
  });

  if (!onChainElig.eligible && onChainElig.reasonCode === 'OTHER_REFERRER') {
    logger.info(
      { userId, walletAddress, agentIdName, details: onChainElig.details },
      'Wallet connect blocked: already completed under another referral code',
    );
    return {
      blocked: true,
      message: OTHER_REFERRER_INELIGIBLE_MESSAGE,
      keyboard: KB.start,
    };
  }

  if (localCompleted.completed || onChainElig.reasonCode === 'ALREADY_COMPLETED_OWN_REFERRER') {
    logger.info(
      { userId, walletAddress, agentIdName, matchedBy: localCompleted.matchedBy ?? 'onchain' },
      'Wallet connect notice: Agent ID / Wallet already completed a full cycle',
    );
    return {
      blocked: true,
      message: ALREADY_COMPLETED_MESSAGE,
      keyboard: KB.start,
    };
  }

  return { blocked: false };
}

export async function handleConnectWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Starting pairing…');

  if (!bawAvailable()) {
    await ctx.reply(
      '❌ Binance Agentic Wallet CLI (@binance/agentic-wallet) is not installed on this server.\n\n' +
      'Ask the bot operator to run "npm ci" and restart the service.',
      KB.start,
    );
    return;
  }

  try {
    const session = await generatePairingUri(userId);

    if (!session) {
      await ctx.reply(
        '❌ Failed to start Binance Wallet pairing.\n\n' +
        'The @binance/agentic-wallet CLI could not create a pairing session.\n' +
        'Check server logs and ensure the deployment has outbound internet access.',
        KB.start,
      );
      return;
    }

    // Handle already-connected case — still run live on-chain referral/completion check
    if (session.walletAddress) {
      const status = await checkConnectedWalletStatus(userId, session.walletAddress, session.agentIdName);
      if (status.blocked) {
        await ctx.reply(status.message, status.keyboard);
        return;
      }

      await ctx.reply(
        `✅ Already connected!\n\nAddress: ${session.walletAddress}\n` +
        (session.agentIdName ? `Agent ID: ${session.agentIdName}\n` : '') +
        '\nTap Complete All Process to run the cycle.',
        KB.afterConnect,
      );
      return;
    }

    await safeUpdateUser(userId, { session_link: session.urlForWeb, current_step: 'connecting' });

    const expiresMin = Math.max(1, Math.round((session.expireAt - Date.now()) / 60000));

    // Generate QR image immediately
    const qrCaption = `🔗 Open in Binance app:\n${session.urlForWeb}`;
    try {
      const qrBuf = await generateQrBuffer(session.urlForWeb);
      await ctx.replyWithPhoto(
        { source: qrBuf, filename: 'connect.png' },
        {
          caption:
            `📱 Scan with your Binance app to connect.\n\n` +
            (session.pairingCode ? `Pairing code: ${session.pairingCode}\n` : '') +
            `Expires in: ${expiresMin} min\n\n` +
            `Or open: ${session.urlForWeb}\n\n` +
            `✅ This message will update automatically when connected.`,
          ...KB.cancelOnly,
        },
      );
    } catch {
      // QR generation failed — send text link
      await ctx.reply(qrCaption, KB.cancelOnly);
    }

    // Background verification — checks on-chain referral eligibility immediately upon binding
    verifyAndBindSession(
      userId,
      session.qrCodeId,
      async (connected) => {
        try {
          if (connected.walletAddress) {
            const status = await checkConnectedWalletStatus(
              userId,
              connected.walletAddress,
              connected.agentIdName,
            );
            if (status.blocked) {
              await ctx.reply(status.message, status.keyboard);
              return;
            }
          }

          await ctx.reply(
            `✅ Wallet connected!\n\n` +
            `Address: ${connected.walletAddress}\n` +
            (connected.agentIdName ? `Agent ID: ${connected.agentIdName}\n` : '(No .ai Agent ID claimed yet)\n') +
            `\nTap Complete All Process to start the mint/sell cycle.`,
            KB.afterConnect,
          );
        } catch (e) { logger.warn({ e, userId }, 'Could not send connected message'); }
      },
      async (reason) => {
        try {
          await ctx.reply(`❌ Pairing failed:\n${reason}\n\nTap Connect Wallet to try again.`, KB.start);
        } catch (e) { logger.warn({ e, userId }, 'Could not send failed message'); }
      },
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleConnectWallet error');
    await ctx.reply('❌ Failed to start pairing. Please try again.', KB.start);
  }
}
