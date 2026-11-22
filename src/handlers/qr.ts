// src/handlers/qr.ts
import { Context } from 'telegraf';
import { getSession, getSessionLinkFromDb } from '../wallet.js';
import { safeUpdateUser } from '../db.js';
import { generateQrBuffer } from '../qr.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ignore */ }
}

export async function handleGenerateQr(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Generating QR code…');

  try {
    // Resolution order:
    //   1. in-memory session (fastest, same process)
    //   2. Supabase session_link (survives bot restarts)
    //   3. No link → instruct user to click Connect Wallet first
    let pairingUri: string | null = getSession(userId)?.urlForWeb ?? null;
    if (!pairingUri) pairingUri = await getSessionLinkFromDb(userId);

    if (!pairingUri) {
      await ctx.reply(
        '⚠️ No pairing link found.\n\n' +
        'Tap Connect Your Binance Wallet first, then come back to generate the QR code.',
        KB.start,
      );
      return;
    }

    const qrBuffer = await generateQrBuffer(pairingUri);
    await safeUpdateUser(userId, { qr_generated: true, current_step: 'qr_shown' });

    await ctx.replyWithPhoto(
      { source: qrBuffer, filename: 'binance_pairing.png' },
      {
        caption:
          '📱 Scan with your Binance app to connect your wallet.\n\n' +
          'Once you approve in the app, the bot will confirm automatically.',
        ...KB.afterQr,
      },
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleGenerateQr failed');
    await ctx.reply('❌ Failed to generate QR code. Please try again.', KB.start);
  }
}
