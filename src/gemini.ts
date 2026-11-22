// src/gemini.ts
// Gemini AI client — intent routing and user-facing response generation.
// Uses @google/genai Interactions API (function calling / tool routing).

import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { logger } from './logger.js';

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ─── Tool definitions ─────────────────────────────────────────────────────────
// Gemini routes user NL input to one of these intents.

const INTENT_TOOLS = [
  {
    type: 'function' as const,
    name: 'connect_wallet',
    description: 'User wants to connect their Binance wallet or start pairing.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'generate_qr',
    description: 'User wants to see a QR code to scan with their Binance app.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'complete_process',
    description:
      'User wants to execute the full mint-approve-sell automation on BSC.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'my_jobs',
    description: 'User wants to see their own status, completed jobs, incomplete/failed attempts, or bound Agent IDs.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'cancel',
    description: 'User wants to cancel or reset their current session.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'general_reply',
    description:
      'User sent a general message; respond helpfully without triggering a flow.',
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'The helpful reply text.' },
      },
      required: ['reply'],
    },
  },
];

export type Intent =
  | 'connect_wallet'
  | 'generate_qr'
  | 'complete_process'
  | 'my_jobs'
  | 'cancel'
  | 'general_reply';

export interface IntentResult {
  intent: Intent;
  reply?: string; // set for general_reply
}

const SYSTEM_INSTRUCTION = `You are the assistant for a Telegram bot that automates BSC (BNB Smart Chain) token minting and selling.
Your job is to classify user intent and route it to the correct action.
Never ask the user for seed phrases, private keys, or to send BNB directly to any address.
Be concise, friendly, and security-conscious.
Always respond in the same language the user writes in.`;

function isGeminiRateLimitError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '');
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
}

/**
 * Routes a user message to an intent using Gemini function calling.
 * Falls back to 'general_reply' if no tool is called.
 */
export async function routeIntent(
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'model'; text: string }> = [],
): Promise<IntentResult> {
  try {
    const historySteps = conversationHistory.flatMap((turn) => [
      {
        type: turn.role === 'user' ? ('user_input' as const) : ('model_output' as const),
        content: [{ type: 'text' as const, text: turn.text }],
      },
    ]);

    const input =
      historySteps.length > 0
        ? [...historySteps, { type: 'user_input' as const, content: [{ type: 'text' as const, text: userMessage }] }]
        : userMessage;

    const response = await ai.interactions.create({
      model: 'gemini-3.8-flash',
      input,
      system_instruction: SYSTEM_INSTRUCTION,
      tools: INTENT_TOOLS,
      store: false,
    });

    for (const step of response.steps ?? []) {
      if (step.type === 'function_call') {
        const intent = step.name as Intent;
        const args = step.arguments as Record<string, unknown> | undefined;
        logger.info({ intent, args }, 'Gemini routed intent');
        return {
          intent,
          reply: typeof args?.reply === 'string' ? args.reply : undefined,
        };
      }
    }

    // If no function call, treat as general reply using output_text
    const text = response.output_text ?? 'How can I help you?';
    return { intent: 'general_reply', reply: text };
  } catch (err) {
    if (isGeminiRateLimitError(err)) {
      logger.warn({ err }, 'Gemini free-tier rate limit / quota reached in routeIntent');
      return {
        intent: 'general_reply',
        reply: 'AI assistant is temporarily rate-limited. Please use the buttons below directly.',
      };
    }
    logger.error({ err }, 'Gemini routeIntent failed');
    return { intent: 'general_reply', reply: 'Sorry, I had trouble understanding that. Please use the buttons below.' };
  }
}

// ─── Summary generation ───────────────────────────────────────────────────────

export interface ExecutionSummaryInput {
  agentId: string;
  mintCostBnb: string;
  tokensReceived: string;
  sellBnb: string;
  pnlOrFee: string;
  mintTxHash: string;
  approveTxHash: string;
  sellTxHash: string;
  status: 'COMPLETED' | 'STOPPED' | 'FAILED';
  stopReason?: string;
}

/**
 * Generates a clean, human-readable execution summary using Gemini.
 */
export async function generateExecutionSummary(
  data: ExecutionSummaryInput,
): Promise<string> {
  try {
    const prompt = `Create a concise, friendly Telegram message summarizing this BSC mint/sell execution result.
Use emojis. Format numbers clearly. Include all transaction hashes as short references.

Data:
- Agent ID: ${data.agentId}
- Status: ${data.status}
- Mint cost: ${data.mintCostBnb} BNB
- AI tokens received: ${data.tokensReceived}
- BNB from sale: ${data.sellBnb} BNB
- P&L / fees: ${data.pnlOrFee} BNB
- Mint TX: ${data.mintTxHash}
- Approve TX: ${data.approveTxHash}
- Sell TX: ${data.sellTxHash}
${data.stopReason ? `- Stop reason: ${data.stopReason}` : ''}

Keep it under 250 words. Use clean plain text only (no Markdown, asterisks, backticks, or HTML tags).`;

    const response = await ai.interactions.create({
      model: 'gemini-3.8-flash',
      input: prompt,
      store: false,
    });

    return response.output_text?.trim() || buildFallbackSummary(data);
  } catch (err) {
    if (isGeminiRateLimitError(err)) {
      logger.warn({ err }, 'Gemini free-tier rate limit / quota reached in generateExecutionSummary — using deterministic fallback');
    } else {
      logger.error({ err }, 'generateExecutionSummary failed — using deterministic fallback');
    }
    return buildFallbackSummary(data);
  }
}

function buildFallbackSummary(data: ExecutionSummaryInput): string {
  const lines = [
    `Execution ${data.status}`,
    `🤖 Agent ID: ${data.agentId}`,
    `💰 Mint Cost: ${data.mintCostBnb} BNB`,
    `🪙 AI Tokens: ${data.tokensReceived}`,
    `💵 Sale Proceeds: ${data.sellBnb} BNB`,
    `📊 P&L: ${data.pnlOrFee} BNB`,
    `📋 Mint TX: ${data.mintTxHash}`,
    `✅ Approve TX: ${data.approveTxHash}`,
    `💱 Sell TX: ${data.sellTxHash}`,
  ];
  if (data.stopReason) lines.push(`⚠️ Stopped: ${data.stopReason}`);
  return lines.join('\n');
}
