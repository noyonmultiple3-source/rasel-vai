// src/handlers/message.ts
// Free-text message handler — routes NL input through Gemini intent classifier.

import { Context } from 'telegraf';
import { routeIntent } from '../gemini.js';
import { handleConnectWallet } from './wallet.js';
import { handleGenerateQr } from './qr.js';
import { handleCompleteProcess } from './execute.js';
import { handleMyJobs } from './jobs.js';
import { handleCancel } from './cancel.js';
import { KB } from '../keyboards.js';

export async function handleMessage(ctx: Context): Promise<void> {
  const text = (ctx.message as { text?: string })?.text;
  if (!text) return;

  // Skip commands — they have dedicated handlers
  if (text.startsWith('/')) return;

  const result = await routeIntent(text);

  switch (result.intent) {
    case 'connect_wallet':
      return handleConnectWallet(ctx);
    case 'generate_qr':
      return handleGenerateQr(ctx);
    case 'complete_process':
      return handleCompleteProcess(ctx);
    case 'my_jobs':
      return handleMyJobs(ctx);
    case 'cancel':
      return handleCancel(ctx);
    case 'general_reply':
    default:
      // FIX #10: Gemini's output_text is arbitrary text that may contain
      // MarkdownV2 special characters. Sending it with parse_mode: 'MarkdownV2'
      // will cause Telegram to reject the message with a 400 Bad Request.
      // Always send AI-generated text as plain text.
      await ctx.reply(
        result.reply ?? 'How can I help you? Use the buttons below.',
        KB.start,
      );
  }
}
