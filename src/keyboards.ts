// src/keyboards.ts
// Telegram inline keyboard definitions — one place for all button layouts.

import { Markup } from 'telegraf';

export const KB = {
  /** Shown on /start for normal users */
  start: Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Connect Your Binance Wallet', 'connect_wallet')],
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown on /start ONLY for configured ADMIN_ID(s) */
  startForAdmin: Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Connect Your Binance Wallet', 'connect_wallet')],
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('🛡️ Admin Dashboard', 'admin_overview')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Admin dashboard navigation (strictly gated by ADMIN_ID check in handlers) */
  adminMenu: Markup.inlineKeyboard([
    [
      Markup.button.callback('🏆 Completed Agent IDs', 'admin_completed'),
      Markup.button.callback('⚠️ Incomplete / Connected', 'admin_incomplete'),
    ],
    [
      Markup.button.callback('👥 All Users', 'admin_users'),
      Markup.button.callback('🔄 Refresh Overview', 'admin_overview'),
    ],
    [
      Markup.button.callback('⏸️ Stop Bot (Users)', 'admin_bot_stop'),
      Markup.button.callback('▶️ Start Bot (Users)', 'admin_bot_start'),
    ],
  ]),

  /** Shown after wallet connection link is generated */
  afterConnect: Markup.inlineKeyboard([
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown after QR code is sent */
  afterQr: Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown when execution is running (single cancel button) */
  cancelOnly: Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Job', 'cancel')],
  ]),

  /** Shown after completion / error */
  postExecution: Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('📊 My Status & Jobs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),
};
