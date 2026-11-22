// src/logger.ts
// Structured logger using pino with safe fallback if pino-pretty is absent.

import pino from 'pino';
import { config } from './config.js';

function resolveTransport(): pino.TransportSingleOptions | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true } };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: resolveTransport(),
});
