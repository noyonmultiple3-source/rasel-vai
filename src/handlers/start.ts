// src/handlers/start.ts
// /start command handler — displays fixed referrer notice and role-aware menu.

import { Context } from 'telegraf';
import { upsertUser } from '../db.js';
import { ADDR, REFERRER_NAME } from '../bsc.js';
import { isAdminId } from '../config.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

export async function handleStart(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  try {
    await upsertUser(user.id, user.username ?? null, user.first_name ?? null);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'handleStart: DB upsert failed (continuing)');
  }

  const name = user.first_name ?? user.username ?? 'there';
  const admin = isAdminId(user.id);

  // Plain text ensures usernames/dots/addresses never fail Telegram MarkdownV2 parsing.
  const welcome = [
    `👋 Welcome, ${name}!`,
    ``,
    `This bot automates BNB Smart Chain (chainId: 56) AI token minting, exact approval, and PancakeSwap V2 selling via your non-custodial Binance Agentic Wallet.`,
    ``,
    `📌 Fixed Referrer Notice:`,
    `• Referrer Code / Agent ID: ${REFERRER_NAME}`,
    `• Referrer Address: ${ADDR.REFERRER}`,
    `This hardcoded referrer is applied automatically on every mint/execution run (never 0x0 and cannot be overridden).`,
    ``,
    `🔒 Security Reminder:`,
    `• We will NEVER ask for your seed phrase or private key.`,
    `• Never send BNB directly to a contract address.`,
    ``,
    `Choose an action below:`,
  ].join('\n');

  await ctx.reply(welcome, admin ? KB.startForAdmin : KB.start);
}

/** Escape MarkdownV2 special characters (retained for utility compatibility) */
export function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
