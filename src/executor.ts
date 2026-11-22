// src/executor.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 3: Cycle Engine — deterministic mint → approve → sell pipeline
//
// Runs automatically without step-by-step confirmations.
// Live status updates are pushed via the `onStatus` callback so the
// Telegram handler can edit a single message rather than spam new ones.
//
// Stop conditions (checked before ANY on-chain write):
//   - No .ai Agent ID on wallet
//   - Insufficient BNB (< mintCost + 0.01 BNB gas buffer; or < 0.005 BNB when resuming sell)
//   - Developer mode not enabled
//   - Mint quota exhausted
//
// Sell behavior:
//   - Instant sell at current market/contract price (no stop-loss percentage block).
//   - Reads live AI balance, live allowance, live quote, and dynamic gas right before
//     each sell attempt and retries continuously until confirmed (stopping only on
//     user cancel, baw session expiration, or 0 AI balance remaining).
//
// Retry logic:
//   - Once minting starts, retries continuously with short backoff, fresh live
//     price (`readCostOf(10n)` + `readTotalMinted()`), and fresh dynamic gas
//     estimation on smart contract call failures / reverts / races / transient
//     RPC errors until success — unless cancelled, session expired, or a hard
//     stop condition (e.g. insufficient BNB, quota exhausted, devMode off) hits.
//   - Before every retry, verifies on-chain AI balance / allowance so an
//     already-landed tx never double-mints, double-approves, or double-sells.
//   - baw SESSION_EXPIRED: propagates immediately so caller can re-pair.
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import {
  readCostOf, readBnbBalance, readAiBalance, readAiAllowance,
  readTxValueWei, pollTransactionReceipt, normalizeAddress,
  checkWalletReferralEligibility, OTHER_REFERRER_INELIGIBLE_MESSAGE,
  runPreflightChecks, simulateSellOutput, simulateContractCall, isValidAiAgentId,
  buildMintCalldata, buildApproveCalldata, buildSellCalldata,
  isMintRaceError, isMintPriceMismatchError, GAS_BUFFER, RESUME_GAS_BUFFER, ADDR,
} from './bsc.js';
import {
  isSessionConnectedDb, executeContractCall, getSession, fetchBawAgentId, getBawWalletSettings, syncAgentId,
} from './wallet.js';
import { generateExecutionSummary } from './gemini.js';
import {
  insertExecution,
  getLatestUnfinishedMint,
  hasCompletedCycleForAgent,
  recordCompletedAgentInMemory,
  isBotPaused,
  pool,
} from './db.js';
import { isAdminId } from './config.js';
import { logger } from './logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const ALREADY_COMPLETED_MESSAGE = 'আহা অশান্তি একটা আইডি দিয়ে কতবার করতে চাচ্ছেন?';

const RETRY_BASE_DELAY_MS  = 1_500; // initial backoff on smart contract call failure
const RETRY_STEP_DELAY_MS  = 500;   // linear backoff increment per attempt
const RETRY_MAX_DELAY_MS   = 5_000; // backoff cap (keeps retries responsive)
const STATUS_THROTTLE_MS   = 3_500; // minimum interval between retry status edits

function computeRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS + Math.max(0, attempt - 1) * RETRY_STEP_DELAY_MS);
}

/** Sleeps in short slices so Cancel responds almost immediately during retry backoff. */
async function sleepWithCancelCheck(userId: number, delayMs: number): Promise<boolean> {
  const sliceMs = 400;
  let elapsed = 0;
  while (elapsed < delayMs) {
    if (isCancelled(userId)) return true;
    const wait = Math.min(sliceMs, delayMs - elapsed);
    await new Promise((r) => setTimeout(r, wait));
    elapsed += wait;
  }
  return isCancelled(userId);
}

/**
 * Identifies explicit hard stop conditions that must NOT be retried infinitely
 * (e.g., genuinely insufficient funds, disabled/expired Developer Mode, exhausted
 * daily quota, missing CLI binary, or invalid address).
 */
function isHardStopError(err: unknown): boolean {
  const e = err as Error & { isSessionExpired?: boolean };
  if (e?.isSessionExpired) return true;
  const msg = String(e?.message ?? err ?? '');
  return (
    /insufficient funds|insufficient balance|not enough bnb/i.test(msg) ||
    /developer mode.*(not enabled|disabled|expired|exceeded)/i.test(msg) ||
    /quota exhausted|daily limit.*exceeded|exceed.*daily.*limit/i.test(msg) ||
    /\b(Quota|NoAgent|Paused|SoldOut)\(\)/i.test(msg) ||
    /CLI binary not found|Invalid EVM/i.test(msg)
  );
}

/** Keeps retry error snippets compact and free of noisy JSON wrappers for Telegram UI. */
function summarizeRetryError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? 'contract call failed')
    .replace(/\s+/g, ' ')
    .trim();
  const msgMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const clean = msgMatch ? msgMatch[1] : raw;
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

// ─── Per-user execution lock ──────────────────────────────────────────────────

const activeLocks  = new Set<number>();
const cancelFlags  = new Map<number, boolean>();

export function isUserLocked(userId: number): boolean { return activeLocks.has(userId); }
export function requestCancelExecution(userId: number): void { cancelFlags.set(userId, true); }
function isCancelled(userId: number): boolean { return cancelFlags.get(userId) === true; }

/** Cancels all active background executions owned by non-admin users when admin stops the bot. */
export function cancelAllNonAdminExecutions(): number {
  let cancelledCount = 0;
  for (const uid of activeLocks) {
    if (!isAdminId(uid)) {
      cancelFlags.set(uid, true);
      cancelledCount++;
    }
  }
  return cancelledCount;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ExecutionSuccess {
  ok: true;
  summary: string;
  agentId: string;
  mintCostBnb: string;
  tokensReceived: string;
  sellBnb: string;
  pnlOrFee: string;
  mintTxHash: string;
  approveTxHash: string;
  sellTxHash: string;
  completedCount: number;
}

export interface ExecutionFailure {
  ok: false;
  reason: string;
  alreadyCompleted?: boolean;
  ineligibleOtherReferrer?: boolean;
  isSessionExpired?: boolean;
  partialTxHashes?: Partial<Record<'mint' | 'approve' | 'sell', string>>;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

/** Called by the handler to edit the live status message. */
export type StatusUpdater = (text: string) => Promise<void>;

// ─── Main cycle engine ────────────────────────────────────────────────────────

export async function runFullExecution(
  userId: number,
  onStatus: StatusUpdater,
): Promise<ExecutionResult> {
  if (isBotPaused() && !isAdminId(userId)) {
    return { ok: false, reason: '⛔ The bot is currently stopped by the administrator. Please try again later.' };
  }

  if (activeLocks.has(userId)) {
    return { ok: false, reason: 'A job is already running for your account. Please wait.' };
  }

  activeLocks.add(userId);
  cancelFlags.set(userId, false);

  const txHashes: Partial<Record<'mint' | 'approve' | 'sell', string>> = {};
  let resolvedWallet = '';
  let resolvedAgentId = '';
  let trackedMintCostWei = 0n;
  let trackedTokensWei   = 0n;

  try {
    // ── 1. Verify wallet session (Supabase-authoritative) ─────────────────────
    await onStatus('🔍 Verifying wallet connection…');

    const { connected, address: rawWalletAddress, dbAgentId } = await isSessionConnectedDb(userId);
    if (!connected || !rawWalletAddress) {
      return { ok: false, reason: 'Wallet not connected. Tap Connect Wallet and complete pairing first.' };
    }

    const walletAddress = normalizeAddress(rawWalletAddress, 'executor.walletAddress');
    resolvedWallet = walletAddress;
    const session = getSession(userId);
    const sessionAgentId = session?.agentIdName?.trim() || '';
    const persistedAgentId = dbAgentId?.trim() || '';

    // If neither memory session nor DB has a valid *.ai Agent ID, re-query `baw wallet agent-id`
    let bawAgentId = '';
    if (!isValidAiAgentId(sessionAgentId) && !isValidAiAgentId(persistedAgentId)) {
      bawAgentId = (await fetchBawAgentId(userId))?.trim() || '';
    }

    let agentId =
      (isValidAiAgentId(sessionAgentId) ? sessionAgentId : '') ||
      (isValidAiAgentId(persistedAgentId) ? persistedAgentId : '') ||
      (isValidAiAgentId(bawAgentId) ? bawAgentId : '') ||
      walletAddress;
    resolvedAgentId = agentId;

    // ── 1b. One-time completed Agent ID / Agent Wallet lock (NEVER keyed by Telegram userId) ──
    const earlyLockCheck = await hasCompletedCycleForAgent({
      agentIdName: isValidAiAgentId(agentId) ? agentId : null,
      walletAddress,
    });
    if (earlyLockCheck.completed) {
      logger.info(
        { userId, walletAddress, agentId, matchedBy: earlyLockCheck.matchedBy },
        'Blocked execution: Agent ID / Agent Wallet already completed a full cycle',
      );
      return { ok: false, alreadyCompleted: true, reason: ALREADY_COMPLETED_MESSAGE };
    }

    // ── 2. Read live mint cost, wallet settings, & check for existing unsold mint ──
    await onStatus('📡 Reading live mint cost, referral eligibility, AI balance & wallet settings…');
    const [mintCostWei, bawSettingsRes, existingAiBalance, unfinishedMint] = await Promise.all([
      readCostOf(10n),
      getBawWalletSettings(userId),
      readAiBalance(walletAddress),
      getLatestUnfinishedMint(userId, walletAddress),
    ]);

    // ── 2b. Authoritative on-chain referral & prior-completion check (MintSale storage) ──
    const referralCheck = await checkWalletReferralEligibility(walletAddress, {
      hasLocalUnfinishedMint: Boolean(unfinishedMint),
    });
    if (!referralCheck.eligible) {
      if (referralCheck.reasonCode === 'OTHER_REFERRER') {
        logger.info(
          { userId, walletAddress, agentId, details: referralCheck.details },
          'Blocked execution: wallet already completed under another referral code',
        );
        return {
          ok: false,
          ineligibleOtherReferrer: true,
          reason: OTHER_REFERRER_INELIGIBLE_MESSAGE,
        };
      }
      if (referralCheck.reasonCode === 'ALREADY_COMPLETED_OWN_REFERRER') {
        recordCompletedAgentInMemory({ agentIdName: agentId, walletAddress });
        logger.info(
          { userId, walletAddress, agentId, details: referralCheck.details },
          'Blocked execution: wallet/Agent ID already completed full quota under our referrer on-chain',
        );
        return {
          ok: false,
          alreadyCompleted: true,
          reason: ALREADY_COMPLETED_MESSAGE,
        };
      }
    }

    const resumingExistingMint = existingAiBalance > 0n;
    const priorMintTxHash = unfinishedMint?.tx_hashes?.mint ?? '';

    if (resumingExistingMint) {
      logger.info(
        {
          userId,
          walletAddress,
          existingAiBalance: ethers.formatUnits(existingAiBalance, 18),
          priorMintTxHash: priorMintTxHash || null,
          priorExecId: unfinishedMint?.id ?? null,
        },
        'Detected unsold AI tokens on-chain — will skip mint and resume Approve → Sell',
      );
    }

    // ── 3. Preflight stop-condition checks ───────────────────────────────────
    await onStatus('🛡 Running preflight checks…');
    const preflight = await runPreflightChecks(walletAddress, mintCostWei, {
      sessionAgentId: sessionAgentId || null,
      dbAgentId: persistedAgentId || null,
      bawAgentId: bawAgentId || null,
      bawSettings: bawSettingsRes.ok ? bawSettingsRes.settings : null,
      bawSettingsError: bawSettingsRes.ok ? null : bawSettingsRes.error,
      skipMintCostBalanceCheck: resumingExistingMint,
    });
    if (preflight.resolvedAgentId) {
      agentId = preflight.resolvedAgentId;
      resolvedAgentId = agentId;
      await syncAgentId(userId, agentId);

      // Re-verify completed Agent ID / Agent Wallet lock if preflight resolved a *.ai Agent ID
      const resolvedLockCheck = await hasCompletedCycleForAgent({
        agentIdName: agentId,
        walletAddress,
      });
      if (resolvedLockCheck.completed) {
        logger.info(
          { userId, walletAddress, agentId, matchedBy: resolvedLockCheck.matchedBy },
          'Blocked execution after preflight: resolved Agent ID / Wallet already completed a full cycle',
        );
        return { ok: false, alreadyCompleted: true, reason: ALREADY_COMPLETED_MESSAGE };
      }
    }
    if (!preflight.ok) {
      const reason = preflight.reason ?? 'Preflight check failed.';
      await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, txHashes, agentId, reason);
      return { ok: false, reason: `⛔ ${reason}` };
    }

    if (isCancelled(userId)) {
      const cancelReason = 'Cancelled by user before execution started.';
      await logExecution(userId, walletAddress, 'CANCELLED', 0n, 0n, 0n, txHashes, agentId, cancelReason);
      return { ok: false, reason: cancelReason };
    }

    // ── 4. MINT (or RESUME from already-broadcast mint with unsold AI tokens) ──
    let mintTxHash = '';
    let tokensReceived = 0n;
    let actualMintCost = 0n;

    if (resumingExistingMint) {
      tokensReceived   = existingAiBalance;
      trackedTokensWei = tokensReceived;
      mintTxHash       = priorMintTxHash || 'resumed-onchain-balance';
      if (priorMintTxHash) txHashes.mint = priorMintTxHash;

      // Recover exact BNB spent on the prior mint TX (DB record → on-chain tx.value → live cost benchmark)
      if (unfinishedMint?.mint_cost_bnb && parseFloat(unfinishedMint.mint_cost_bnb) > 0) {
        try {
          actualMintCost = ethers.parseEther(unfinishedMint.mint_cost_bnb);
        } catch { /* fallback below */ }
      }
      if (actualMintCost === 0n && priorMintTxHash) {
        const onChainVal = await readTxValueWei(priorMintTxHash);
        if (onChainVal != null && onChainVal > 0n) actualMintCost = onChainVal;
      }
      if (actualMintCost === 0n) {
        actualMintCost = mintCostWei;
      }
      trackedMintCostWei = actualMintCost;

      await onStatus(
        `♻️ Found existing unsold AI tokens (${ethers.formatUnits(tokensReceived, 18)} AI)` +
        (priorMintTxHash ? ` from Mint TX ${priorMintTxHash.slice(0, 12)}…` : '') +
        `.\nSkipping re-mint and resuming Approve → Sell…`,
      );
      logger.info(
        {
          userId,
          step: 'resume_from_mint',
          mintTxHash,
          recoveredMintCostBnb: ethers.formatEther(actualMintCost),
          tokensReceived: ethers.formatUnits(tokensReceived, 18),
        },
        'Resuming cycle after already-broadcast mint',
      );
    } else {
      // Continuous retry loop: keeps retrying on smart contract call failures / reverts /
      // simulation or RPC errors / price moves with fresh live cost + fresh gas estimate
      // until mint succeeds — stopping ONLY on user cancel, session expiry, or hard guard.
      let mintAttempt = 0;
      let lastRetryEditAt = 0;

      const updateRetryStatus = async (text: string, force = false): Promise<void> => {
        const now = Date.now();
        if (force || mintAttempt <= 3 || now - lastRetryEditAt >= STATUS_THROTTLE_MS) {
          lastRetryEditAt = now;
          await onStatus(text);
        }
      };

      while (true) {
        if (isCancelled(userId)) {
          const cancelReason = `Cancelled by user during mint (after ${mintAttempt} attempt(s)).`;
          await logExecution(userId, walletAddress, 'CANCELLED', 0n, 0n, 0n, txHashes, agentId, cancelReason);
          return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
        }

        // Guard against accidental double-mint if a prior attempt's tx actually landed on-chain
        if (mintAttempt > 0) {
          try {
            const onChainAiNow = await readAiBalance(walletAddress);
            if (onChainAiNow > 0n) {
              tokensReceived   = onChainAiNow;
              trackedTokensWei = tokensReceived;
              if (!mintTxHash) mintTxHash = txHashes.mint ?? 'confirmed-onchain';
              if (actualMintCost === 0n) actualMintCost = mintCostWei;
              trackedMintCostWei = actualMintCost;
              logger.info(
                { userId, step: 'mint', mintAttempt, tokensReceived: tokensReceived.toString() },
                'Detected confirmed AI tokens on-chain before retry — skipping redundant mint',
              );
              await onStatus(`✅ Previous mint confirmed on-chain (${ethers.formatUnits(tokensReceived, 18)} AI).\nProceeding to Approve → Sell…`);
              break;
            }
          } catch (balErr) {
            logger.warn({ userId, err: (balErr as Error)?.message }, 'Pre-retry AI balance check failed — continuing');
          }
        }

        mintAttempt++;
        let liveCostBnb = '';

        try {
          // Always resolve the LIVE on-chain mint price & totalMinted right before each attempt
          // (never reuse stale preflight or previous-attempt cost as share prices rise over time).
          const [{ inputData, value, maxCost, expectedStart }, liveBnbBal] = await Promise.all([
            buildMintCalldata(10n),
            readBnbBalance(walletAddress),
          ]);
          actualMintCost     = maxCost;
          trackedMintCostWei = maxCost;

          liveCostBnb     = ethers.formatEther(maxCost);
          const neededBnb = maxCost + GAS_BUFFER;

          await updateRetryStatus(
            `🔄 Minting (attempt #${mintAttempt})…\n` +
            `Live mint cost: ${liveCostBnb} BNB`,
            mintAttempt === 1,
          );

          logger.info(
            {
              userId,
              step: 'mint',
              attempt: mintAttempt,
              to: ADDR.MINT_CONTRACT,
              shares: '10',
              referrer: ADDR.REFERRER,
              preflightCostBnb: ethers.formatEther(mintCostWei),
              liveMintCostBnb: liveCostBnb,
              priceMovedSincePreflight: maxCost !== mintCostWei,
              liveBnbBalance: ethers.formatEther(liveBnbBal),
              expectedStart: expectedStart.toString(),
            },
            'Prepared live mint calldata',
          );

          // Hard guard: genuinely insufficient BNB for the fresh live mint cost + gas buffer
          if (liveBnbBal < neededBnb) {
            const balReason =
              `Insufficient BNB for live mint price. Need ≥ ${ethers.formatEther(neededBnb)} BNB ` +
              `(live mint cost ${liveCostBnb} BNB + gas buffer), have ${ethers.formatEther(liveBnbBal)} BNB.`;
            await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, txHashes, agentId, balReason);
            return { ok: false, reason: `⛔ ${balReason}`, partialTxHashes: txHashes };
          }

          // Read-only BSC RPC simulation: estimates dynamic gas and detects reverts before broadcast.
          const mintSim = await simulateContractCall({
            step:  'mint',
            from:  walletAddress,
            to:    ADDR.MINT_CONTRACT,
            data:  inputData,
            value,
          });

          if (!mintSim.ok && mintSim.isRevert) {
            const reasonDetail = mintSim.revertReason ?? mintSim.error ?? 'contract simulation reverted';
            const errObj = Object.assign(
              new Error(`Smart contract call simulation failed: ${reasonDetail}`),
              { data: mintSim.revertData },
            );
            throw errObj;
          }

          // Dynamic gasLimit = estimateGas * 1.4 (or 900k fallback ceiling if RPC estimate unavailable),
          // with automatic single retry at a higher buffer if baw preview returns 351805.
          const result = await executeContractCall({
            userId,
            step:             'mint',
            walletAddress,
            to:               ADDR.MINT_CONTRACT,
            inputData,
            value,
            rpcEstimatedGas:  mintSim.estimatedGas,
            fallbackGasLimit: 900_000,
          });

          mintTxHash = result.txHash;
          txHashes.mint = mintTxHash;

          // Poll BSC receipt (status === 1 confirmed vs status === 0 reverted) with cancel checks
          await onStatus(`⏳ Mint submitted (${mintTxHash.slice(0, 10)}…). Waiting for BSC receipt…`);
          const mintReceipt = await pollTransactionReceipt(mintTxHash, {
            timeoutMs:      90_000,
            pollIntervalMs: 1_500,
            walletAddress,
            isCancelled:    () => isCancelled(userId),
          });

          if (mintReceipt.state === 'cancelled') {
            const cancelReason = `Cancelled while waiting for mint receipt (${mintTxHash}).`;
            await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, 0n, 0n, txHashes, agentId, cancelReason);
            return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
          }

          if (mintReceipt.state === 'reverted') {
            // Transaction reverted on-chain (status === 0) — do NOT treat as pending 0-balance!
            const revertedHash = mintTxHash;
            delete txHashes.mint;
            mintTxHash = '';

            // Immediately re-check on-chain referral/quota eligibility so we don't retry a hard-blocked wallet
            const postRevertCheck = await checkWalletReferralEligibility(walletAddress);
            if (!postRevertCheck.eligible) {
              if (postRevertCheck.reasonCode === 'OTHER_REFERRER') {
                return {
                  ok: false,
                  ineligibleOtherReferrer: true,
                  reason: OTHER_REFERRER_INELIGIBLE_MESSAGE,
                };
              }
              if (postRevertCheck.reasonCode === 'ALREADY_COMPLETED_OWN_REFERRER') {
                recordCompletedAgentInMemory({ agentIdName: agentId, walletAddress });
                return { ok: false, alreadyCompleted: true, reason: ALREADY_COMPLETED_MESSAGE };
              }
            }

            throw new Error(
              `Mint TX ${revertedHash.slice(0, 12)}… reverted on-chain (status=0, gasUsed=${mintReceipt.receipt.gasUsed.toString()}) — retrying with fresh live price & expectedStart`,
            );
          }

          if (mintReceipt.state === 'timeout') {
            // Check once if balance already reflected despite receipt polling timeout
            tokensReceived = await readAiBalance(walletAddress).catch(() => 0n);
            if (tokensReceived === 0n) {
              const timeoutReason =
                `Mint TX ${mintTxHash} has not confirmed on BSC within 90s. ` +
                `Wait briefly and tap Complete All Process again to resume automatically if it confirms.`;
              await logExecution(userId, walletAddress, 'FAILED', actualMintCost, 0n, 0n, txHashes, agentId, timeoutReason);
              return { ok: false, reason: `⚠️ ${timeoutReason}`, partialTxHashes: txHashes };
            }
          } else {
            // Receipt confirmed (status === 1): poll readAiBalance across short intervals to handle RPC read lag
            await onStatus(`✅ Mint confirmed in block #${mintReceipt.receipt.blockNumber}. Verifying AI token balance…`);
            tokensReceived = 0n;
            for (let poll = 0; poll < 15; poll++) {
              if (isCancelled(userId)) {
                const cancelReason = `Cancelled after mint confirmed (${mintTxHash}).`;
                await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
                return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
              }
              try {
                tokensReceived = await readAiBalance(walletAddress);
                if (tokensReceived > 0n) break;
              } catch (balErr) {
                logger.warn({ userId, poll, err: (balErr as Error)?.message }, 'Post-mint readAiBalance transient error');
              }
              await sleepWithCancelCheck(userId, 1_500);
            }

            // Fallback to Transfer log amount from the confirmed receipt if RPC balanceOf still lags
            if (tokensReceived === 0n && mintReceipt.mintedTokensFromLogs > 0n) {
              logger.warn(
                {
                  userId,
                  mintTxHash,
                  mintedTokensFromLogs: mintReceipt.mintedTokensFromLogs.toString(),
                },
                'Post-mint balanceOf lagged after confirmed receipt — using confirmed Transfer log amount',
              );
              tokensReceived = mintReceipt.mintedTokensFromLogs;
            }
          }

          trackedTokensWei = tokensReceived;
          if (tokensReceived === 0n) {
            const zeroReason =
              `Mint TX ${mintTxHash} confirmed on-chain, but AI token balance is still 0. ` +
              `Tap Complete All Process again once RPC syncs to resume Approve → Sell.`;
            await logExecution(userId, walletAddress, 'FAILED', actualMintCost, 0n, 0n, txHashes, agentId, zeroReason);
            return { ok: false, reason: `⚠️ ${zeroReason}`, partialTxHashes: txHashes };
          }

          logger.info(
            {
              userId,
              step: 'mint',
              attempt: mintAttempt,
              mintTxHash,
              liveMintCostBnb: liveCostBnb,
              appliedGasLimit: result.appliedGasLimit,
              tokensReceived: tokensReceived.toString(),
            },
            'Mint confirmed & AI balance verified',
          );
          break; // success

        } catch (err) {
          const e = err as Error & { isSessionExpired?: boolean };

          // Hard stop 1: Binance Agentic Wallet session expired / disconnected
          if (e.isSessionExpired) {
            const expReason = 'Binance Wallet session expired during mint. Please reconnect.';
            await logExecution(userId, walletAddress, 'FAILED', 0n, 0n, 0n, txHashes, agentId, expReason);
            return {
              ok: false,
              isSessionExpired: true,
              reason: expReason,
              partialTxHashes: txHashes,
            };
          }

          // Hard stop 2: Explicit non-recoverable guard (insufficient funds, devMode off, quota exhausted, etc.)
          if (isHardStopError(err)) {
            const hardReason = `Mint stopped by guard: ${summarizeRetryError(err)}`;
            await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, txHashes, agentId, hardReason);
            return { ok: false, reason: `⛔ ${hardReason}`, partialTxHashes: txHashes };
          }

          // Retryable smart contract call failure / revert / race / price move / transient RPC error:
          // back off briefly, then refresh live mint cost + totalMinted + dynamic gas and retry until success.
          const delayMs = computeRetryDelayMs(mintAttempt);
          const shortErr = summarizeRetryError(err);
          const isRaceOrPrice = isMintRaceError(err) || isMintPriceMismatchError(err);

          logger.warn(
            {
              userId,
              step: 'mint',
              attempt: mintAttempt,
              liveMintCostBnb: liveCostBnb || null,
              isRaceOrPrice,
              retryDelayMs: delayMs,
              err: shortErr,
            },
            'Mint smart contract call failed — retrying with fresh live price & gas estimate',
          );

          await updateRetryStatus(
            `🔁 Mint attempt #${mintAttempt} failed — retrying automatically…\n` +
            (liveCostBnb ? `Last live cost: ${liveCostBnb} BNB\n` : '') +
            `Reason: ${shortErr}\n` +
            `Next retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );

          const cancelledDuringSleep = await sleepWithCancelCheck(userId, delayMs);
          if (cancelledDuringSleep) {
            const cancelReason = `Cancelled by user while retrying mint (after ${mintAttempt} attempt(s)).`;
            await logExecution(userId, walletAddress, 'CANCELLED', 0n, 0n, 0n, txHashes, agentId, cancelReason);
            return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
          }
        }
      }
    }

    if (isCancelled(userId)) {
      const cancelReason = `Cancelled after mint. Mint TX: ${mintTxHash} already broadcast.`;
      await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
      return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
    }

    const mintCostF = parseFloat(ethers.formatEther(actualMintCost));

    // ── 5. APPROVE (exact amount, retries on smart contract call failure until confirmed) ──
    let approveTxHash = unfinishedMint?.tx_hashes?.approve ?? '';
    let approveAttempt = 0;
    let lastApproveEditAt = 0;

    while (true) {
      if (isCancelled(userId)) {
        const cancelReason = `Cancelled before/during approve. Mint TX: ${mintTxHash}`;
        await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
        return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
      }

      const currentAllowance = await readAiAllowance(walletAddress, ADDR.PANCAKE_ROUTER);
      if (currentAllowance >= tokensReceived) {
        if (!approveTxHash) approveTxHash = 'already-approved';
        else txHashes.approve = approveTxHash;
        logger.info(
          {
            userId,
            step: 'approve',
            token: ADDR.AI_TOKEN,
            spender: ADDR.PANCAKE_ROUTER,
            currentAllowance: currentAllowance.toString(),
            tokensReceived: tokensReceived.toString(),
          },
          'Sufficient AI allowance already present — skipping approve tx',
        );
        await onStatus(`✅ Allowance active for ${ethers.formatUnits(tokensReceived, 18)} AI tokens.\nProceeding to sell…`);
        break;
      }

      approveAttempt++;
      try {
        const liveGasBnb = await readBnbBalance(walletAddress);
        if (liveGasBnb < RESUME_GAS_BUFFER / 2n) {
          const gasReason = `Insufficient BNB for approve gas (have ${ethers.formatEther(liveGasBnb)} BNB).`;
          await logExecution(userId, walletAddress, 'STOPPED', actualMintCost, tokensReceived, 0n, txHashes, agentId, gasReason);
          return { ok: false, reason: `⛔ ${gasReason}`, partialTxHashes: txHashes };
        }

        const now = Date.now();
        if (approveAttempt <= 2 || now - lastApproveEditAt >= STATUS_THROTTLE_MS) {
          lastApproveEditAt = now;
          await onStatus(
            `${resumingExistingMint ? '♻️ Resuming' : '✅ Mint confirmed'} — ${ethers.formatUnits(tokensReceived, 18)} AI tokens.\n` +
            `🔐 Approving exact AI amount → PancakeSwap Router${approveAttempt > 1 ? ` (attempt #${approveAttempt})` : ''}…`,
          );
        }

        logger.info(
          {
            userId,
            step: 'approve',
            attempt: approveAttempt,
            token: ADDR.AI_TOKEN,
            spender: ADDR.PANCAKE_ROUTER,
            walletAddress,
            amount: tokensReceived.toString(),
          },
          'Prepared approve calldata with normalized addresses',
        );

        const approveData   = buildApproveCalldata(tokensReceived);
        const approveSim    = await simulateContractCall({
          step: 'approve', from: walletAddress, to: ADDR.AI_TOKEN, data: approveData, value: 0n,
        });
        const approveResult = await executeContractCall({
          userId,
          step: 'approve',
          walletAddress,
          to: ADDR.AI_TOKEN,
          inputData: approveData,
          value: 0n,
          rpcEstimatedGas: approveSim.estimatedGas,
          fallbackGasLimit: 180_000,
        });
        approveTxHash    = approveResult.txHash;
        txHashes.approve = approveTxHash;

        await onStatus(`⏳ Approve submitted (${approveTxHash.slice(0, 10)}…). Waiting for BSC receipt…`);
        const approveReceipt = await pollTransactionReceipt(approveTxHash, {
          timeoutMs: 60_000,
          pollIntervalMs: 1_500,
          isCancelled: () => isCancelled(userId),
        });
        if (approveReceipt.state === 'cancelled') {
          const cancelReason = `Cancelled while waiting for approve receipt (${approveTxHash}). Mint TX: ${mintTxHash}`;
          await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
          return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
        }
        if (approveReceipt.state === 'reverted') {
          const revertedApprove = approveTxHash;
          delete txHashes.approve;
          approveTxHash = '';
          throw new Error(`Approve TX ${revertedApprove.slice(0, 12)}… reverted on-chain (status=0)`);
        }
        break;
      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e.isSessionExpired) throw Object.assign(e, { step: 'approve' });
        if (isHardStopError(err)) throw err;

        const delayMs = computeRetryDelayMs(approveAttempt);
        const shortErr = summarizeRetryError(err);
        logger.warn(
          { userId, step: 'approve', attempt: approveAttempt, retryDelayMs: delayMs, err: shortErr },
          'Approve smart contract call failed — retrying with fresh gas estimate',
        );
        const now = Date.now();
        if (approveAttempt <= 3 || now - lastApproveEditAt >= STATUS_THROTTLE_MS) {
          lastApproveEditAt = now;
          await onStatus(
            `🔁 Approve attempt #${approveAttempt} failed — retrying…\n` +
            `Reason: ${shortErr}\nNext retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );
        }
        if (await sleepWithCancelCheck(userId, delayMs)) {
          const cancelReason = `Cancelled during approve retries. Mint TX: ${mintTxHash}`;
          await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
          return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
        }
      }
    }

    if (isCancelled(userId)) {
      const cancelReason = `Cancelled after approve. Mint: ${mintTxHash}, Approve: ${approveTxHash}`;
      await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
      return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
    }

    // ── 6. INSTANT SELL AT CURRENT MARKET PRICE (retries until confirmed) ────
    // No 8% stop-loss block: sells immediately at whatever live market/contract
    // quote is available. Keeps retrying on contract/simulation/RPC/baw failures
    // until confirmed — stopping only on user cancel, session expiration, or 0 AI balance.
    const bnbBefore = await readBnbBalance(walletAddress);
    let sellTxHash = '';
    let sellWbnbFromLogs = 0n;
    let sellAttempt = 0;
    let lastSellEditAt = 0;
    let soldTokensWei = tokensReceived;

    while (true) {
      if (isCancelled(userId)) {
        const cancelReason = `Cancelled before/during sell. Mint: ${mintTxHash}, Approve: ${approveTxHash}`;
        await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, soldTokensWei, 0n, txHashes, agentId, cancelReason);
        return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
      }

      sellAttempt++;
      try {
        // Read live token balance & allowance right before every sell attempt
        const [liveAiBalance, liveAllowance] = await Promise.all([
          readAiBalance(walletAddress),
          readAiAllowance(walletAddress, ADDR.PANCAKE_ROUTER),
        ]);

        if (liveAiBalance === 0n) {
          if (sellAttempt > 1 || txHashes.sell) {
            if (!sellTxHash) sellTxHash = txHashes.sell ?? 'confirmed-onchain';
            logger.info({ userId, step: 'sell', sellAttempt }, 'AI balance is 0 — previous sell confirmed on-chain');
            break;
          }
          const zeroBalReason = 'No AI token balance remaining in wallet to sell.';
          await logExecution(userId, walletAddress, 'STOPPED', actualMintCost, 0n, 0n, txHashes, agentId, zeroBalReason);
          return { ok: false, reason: `⚠️ ${zeroBalReason}`, partialTxHashes: txHashes };
        }

        soldTokensWei    = liveAiBalance;
        tokensReceived   = liveAiBalance;
        trackedTokensWei = liveAiBalance;

        // Ensure live allowance covers the live AI balance before selling
        if (liveAllowance < liveAiBalance) {
          logger.info(
            {
              userId,
              step: 'sell_reapprove',
              attempt: sellAttempt,
              liveAllowance: liveAllowance.toString(),
              liveAiBalance: liveAiBalance.toString(),
            },
            'Live AI allowance below balance before sell — approving exact live balance',
          );
          const reApproveData = buildApproveCalldata(liveAiBalance);
          const reApproveSim  = await simulateContractCall({
            step: 'approve', from: walletAddress, to: ADDR.AI_TOKEN, data: reApproveData, value: 0n,
          });
          const reApproveRes  = await executeContractCall({
            userId,
            step: 'approve',
            walletAddress,
            to: ADDR.AI_TOKEN,
            inputData: reApproveData,
            value: 0n,
            rpcEstimatedGas: reApproveSim.estimatedGas,
            fallbackGasLimit: 180_000,
          });
          approveTxHash    = reApproveRes.txHash;
          txHashes.approve = approveTxHash;
          const reApproveReceipt = await pollTransactionReceipt(approveTxHash, {
            timeoutMs: 60_000,
            pollIntervalMs: 1_500,
            isCancelled: () => isCancelled(userId),
          });
          if (reApproveReceipt.state === 'reverted') {
            delete txHashes.approve;
            approveTxHash = '';
            throw new Error('Re-approve TX reverted on-chain (status=0)');
          }
        }

        // Informational live quote only (never blocks selling regardless of price vs mint cost)
        const liveQuoteWei = await simulateSellOutput(liveAiBalance);
        const liveQuoteBnb = liveQuoteWei > 0n ? ethers.formatEther(liveQuoteWei) : 'market';

        const now = Date.now();
        if (sellAttempt <= 2 || now - lastSellEditAt >= STATUS_THROTTLE_MS) {
          lastSellEditAt = now;
          await onStatus(
            `💱 Selling ${ethers.formatUnits(liveAiBalance, 18)} AI tokens at current market price` +
            `${liveQuoteWei > 0n ? ` (~${parseFloat(liveQuoteBnb).toFixed(5)} BNB est.)` : ''}` +
            `${sellAttempt > 1 ? ` (attempt #${sellAttempt})` : ''}…`,
          );
        }

        logger.info(
          {
            userId,
            step: 'sell',
            attempt: sellAttempt,
            router: ADDR.PANCAKE_ROUTER,
            tokenIn: ADDR.AI_TOKEN,
            tokenOut: ADDR.WBNB,
            recipient: walletAddress,
            amountIn: liveAiBalance.toString(),
            liveQuoteBnb,
          },
          'Prepared live market sell calldata with normalized addresses',
        );

        const sellData   = buildSellCalldata(liveAiBalance, walletAddress);
        const sellSim    = await simulateContractCall({
          step: 'sell', from: walletAddress, to: ADDR.PANCAKE_ROUTER, data: sellData, value: 0n,
        });
        const sellResult = await executeContractCall({
          userId,
          step: 'sell',
          walletAddress,
          to: ADDR.PANCAKE_ROUTER,
          inputData: sellData,
          value: 0n,
          rpcEstimatedGas: sellSim.estimatedGas,
          fallbackGasLimit: 650_000,
        });
        sellTxHash    = sellResult.txHash;
        txHashes.sell = sellTxHash;

        await onStatus(`⏳ Sell submitted (${sellTxHash.slice(0, 10)}…). Waiting for BSC receipt…`);
        const sellReceipt = await pollTransactionReceipt(sellTxHash, {
          timeoutMs: 60_000,
          pollIntervalMs: 1_500,
          isCancelled: () => isCancelled(userId),
        });
        if (sellReceipt.state === 'cancelled') {
          const cancelReason = `Cancelled while waiting for sell receipt (${sellTxHash}). Mint: ${mintTxHash}, Approve: ${approveTxHash}`;
          await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, soldTokensWei, 0n, txHashes, agentId, cancelReason);
          return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
        }
        if (sellReceipt.state === 'reverted') {
          const revertedSell = sellTxHash;
          delete txHashes.sell;
          sellTxHash = '';
          throw new Error(`Sell TX ${revertedSell.slice(0, 12)}… reverted on-chain (status=0)`);
        }
        if (sellReceipt.state === 'confirmed') {
          sellWbnbFromLogs = sellReceipt.wbnbOutFromLogs;
        }
        break;
      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e.isSessionExpired) throw Object.assign(e, { step: 'sell' });

        const delayMs  = computeRetryDelayMs(sellAttempt);
        const shortErr = summarizeRetryError(err);
        logger.warn(
          { userId, step: 'sell', attempt: sellAttempt, retryDelayMs: delayMs, err: shortErr },
          'Sell attempt failed — retrying with fresh live balance, quote & gas estimate',
        );
        const now = Date.now();
        if (sellAttempt <= 3 || now - lastSellEditAt >= STATUS_THROTTLE_MS) {
          lastSellEditAt = now;
          await onStatus(
            `🔁 Sell attempt #${sellAttempt} failed — retrying automatically…\n` +
            `Reason: ${shortErr}\nNext retry in ${(delayMs / 1000).toFixed(1)}s (tap Cancel to stop).`,
          );
        }
        if (await sleepWithCancelCheck(userId, delayMs)) {
          const cancelReason = `Cancelled during sell retries. Mint: ${mintTxHash}, Approve: ${approveTxHash}`;
          await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, soldTokensWei, 0n, txHashes, agentId, cancelReason);
          return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
        }
      }
    }

    // ── 8. Compute actual BNB received (reuse WBNB Withdrawal log from sell receipt; 0 extra RPC when present) ──
    let bnbReceived = sellWbnbFromLogs;
    if (bnbReceived === 0n) {
      const bnbAfter = await readBnbBalance(walletAddress);
      bnbReceived = bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0n;
    }
    const bnbReceivedF    = parseFloat(ethers.formatEther(bnbReceived));
    const pnl             = bnbReceivedF - mintCostF;
    const mintCostStr     = mintCostF.toFixed(6);
    const tokensStr       = ethers.formatUnits(tokensReceived, 18);
    const sellBnbStr      = bnbReceivedF.toFixed(6);
    const pnlStr          = pnl.toFixed(6);

    // ── 9 & 10. Build instant summary + persist to DB in parallel (zero sequential waterfall) ──
    const [completedCount, summary] = await Promise.all([
      logExecution(userId, walletAddress, 'COMPLETED', actualMintCost, tokensReceived, bnbReceived, txHashes, agentId),
      generateExecutionSummary({
        agentId,
        mintCostBnb:    mintCostStr,
        tokensReceived: tokensStr,
        sellBnb:        sellBnbStr,
        pnlOrFee:       pnlStr,
        mintTxHash:     mintTxHash,
        approveTxHash:  approveTxHash,
        sellTxHash:     sellTxHash,
        status:         'COMPLETED',
      }),
    ]);

    return {
      ok: true,
      summary,
      agentId,
      mintCostBnb:    mintCostStr,
      tokensReceived: tokensStr,
      sellBnb:        sellBnbStr,
      pnlOrFee:       pnlStr,
      mintTxHash,
      approveTxHash,
      sellTxHash,
      completedCount,
    };

  } catch (err: unknown) {
    const e   = err as Error & { isSessionExpired?: boolean; step?: string };
    const msg = e.message ?? String(err);
    logger.error({ userId, err: msg, txHashes }, 'Execution failed');
    if (e.isSessionExpired) {
      const expReason = `Binance Wallet session expired during ${e.step ?? 'execution'}. Please reconnect and try again.`;
      await logExecution(userId, resolvedWallet, 'FAILED', trackedMintCostWei, trackedTokensWei, 0n, txHashes, resolvedAgentId, expReason).catch(() => {});
      return { ok: false, isSessionExpired: true,
        reason: expReason,
        partialTxHashes: txHashes };
    }
    await logExecution(userId, resolvedWallet, 'FAILED', trackedMintCostWei, trackedTokensWei, 0n, txHashes, resolvedAgentId, msg.slice(0, 300)).catch(() => {});
    return { ok: false, reason: `Execution failed: ${msg}`, partialTxHashes: txHashes };

  } finally {
    activeLocks.delete(userId);
    cancelFlags.delete(userId);
  }
}

// ─── DB persistence ───────────────────────────────────────────────────────────

async function logExecution(
  userId: number,
  walletAddress: string,
  status: string,
  mintCostWei: bigint,
  tokensWei: bigint,
  sellWei: bigint,
  txHashes: Partial<Record<string, string>>,
  agentId: string,
  stopReason?: string,
): Promise<number> {
  try {
    const mintCostBnb = parseFloat(ethers.formatEther(mintCostWei));
    const tokensF     = parseFloat(ethers.formatUnits(tokensWei, 18));
    const sellBnbF    = parseFloat(ethers.formatEther(sellWei));
    const pnl         = sellBnbF - mintCostBnb;

    const agentIdName: string | null =
      agentId?.trim() ? agentId.trim()
      : walletAddress?.trim() ? walletAddress.trim()
      : null;

    const insertPromise = insertExecution({
      telegram_user_id: userId,
      wallet_address:   walletAddress?.trim() || null,
      agent_id_name:    agentIdName,
      status,
      mint_cost_bnb:    mintCostBnb !== 0 ? mintCostBnb.toFixed(8) : null,
      tokens_received:  tokensF     !== 0 ? tokensF.toFixed(8)     : null,
      sell_bnb:         sellBnbF    !== 0 ? sellBnbF.toFixed(8)    : null,
      pnl_or_fee:       pnl.toFixed(8),
      tx_hashes: Object.keys(txHashes).length > 0
        ? (txHashes as Record<string, string>) : null,
      summary: stopReason ?? null,
    });

    if (status === 'COMPLETED') {
      recordCompletedAgentInMemory({ agentIdName, walletAddress });
      const [, userRes] = await Promise.all([
        insertPromise,
        pool.query<{ completed_count: number }>(
          `UPDATE users
           SET completed_count = completed_count + 1,
               current_step    = 'completed',
               last_active_at  = now()
           WHERE telegram_user_id = $1
           RETURNING completed_count`,
          [userId],
        ),
      ]);
      return userRes.rows[0]?.completed_count ?? 1;
    }

    await insertPromise;
    return 0;
  } catch (dbErr) {
    logger.error({ dbErr }, 'logExecution: DB write failed');
    return status === 'COMPLETED' ? 1 : 0;
  }
}
