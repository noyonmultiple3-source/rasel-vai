// src/bsc.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 2: Chain Layer — BSC RPC reads & calldata building (chainId: 56)
//
// All on-chain READS use ethers.js directly (read-only, no signing needed).
// All on-chain WRITES are built here as calldata and executed in executor.ts
// via wallet.ts → executeContractCall() → baw contract-call.
//
// Contracts:
//   MINT_CONTRACT  = 0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D
//   AI_TOKEN       = 0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924f
//   WBNB           = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
//   PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E
//   REFERRER       = 0x85377229b28515432cCF1e1c4999BB71C9AdBE11 (noyonislam.ai — NEVER change)
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

// ─── Provider (read-only) ─────────────────────────────────────────────────────

export const provider = new ethers.JsonRpcProvider(config.BSC_RPC_URL, {
  chainId: 56,
  name: 'bnb',
});

// ─── Address Normalization (EIP-55 safe for ethers v6) ───────────────────────

/**
 * Validates a 20-byte EVM hex address and returns its canonical EIP-55 checksummed
 * representation by lowercasing first so mis-cased mixed-case literals never throw
 * ethers v6 `bad address checksum` (INVALID_ARGUMENT).
 */
export function normalizeAddress(raw: string, label = 'address'): string {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`Invalid EVM ${label}: "${raw}"`);
  }
  const normalized = ethers.getAddress(trimmed.toLowerCase());
  if (trimmed !== normalized) {
    logger.info(
      { label, original: trimmed, normalized },
      'Normalized EVM address to canonical EIP-55 checksum',
    );
  }
  return normalized;
}

// ─── Addresses (all EIP-55 normalized at load time) ──────────────────────────

export const ADDR = {
  MINT_CONTRACT:  normalizeAddress('0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D', 'ADDR.MINT_CONTRACT'),
  AI_TOKEN:       normalizeAddress('0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924f', 'ADDR.AI_TOKEN'),
  WBNB:           normalizeAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'ADDR.WBNB'),
  PANCAKE_ROUTER: normalizeAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E', 'ADDR.PANCAKE_ROUTER'),
  REFERRER:       normalizeAddress('0x85377229b28515432cCF1e1c4999BB71C9AdBE11', 'ADDR.REFERRER'), // noyonislam.ai — NEVER change
} as const;

export const REFERRER_NAME = 'noyonislam.ai' as const;

export const OTHER_REFERRER_INELIGIBLE_MESSAGE =
  'এই অ্যাকাউন্ট অলরেডি অন্য একটা রেফার কোড দিয়ে কাজ সম্পন্ন করা হয়েছে এই জন্য আপনার ওয়ালেট নট ইলিজিবল' as const;

// ─── ABIs (verified against MintSale.sol on BSC chainId 56 via Sourcify) ─────

const MINT_ABI = [
  'function costOf(uint256 shares) external view returns (uint256)',
  'function totalMinted() external view returns (uint256)',
  'function TOTAL_SHARES() external view returns (uint256)',
  'function BASE_PER_ID() external view returns (uint256)',
  'function MAX_PER_TX() external view returns (uint256)',
  'function paused() external view returns (bool)',
  'function registrar() external view returns (address)',
  'function paidOnce(address user) external view returns (bool)',
  'function referrerOf(address user) external view returns (address)',
  'function referrerIdOf(address user) external view returns (uint256)',
  'function inviteShares(address user) external view returns (uint256)',
  'function mintedCount(uint256 agentTokenId) external view returns (uint256)',
  'function quotaOf(uint256 agentTokenId) external view returns (uint256)',
  'function mint(uint256 shares, address referrer, uint256 maxCost, uint256 expectedStart, uint256 minTokens, uint256 deadline) external payable',
  'event ReferralBound(address indexed invitee, address indexed referrer, uint256 indexed referrerId)',
  'event Minted(address indexed minter, uint256 indexed agentTokenId, uint256 firstSerial, uint256 shares, uint256 paid, address indexed referrer, uint256 referrerPaid, uint256 marketingPaid)',
  'error Paused()',
  'error BadShares()',
  'error SoldOut()',
  'error NoAgent()',
  'error Quota()',
  'error OverMaxCost()',
  'error BadPayment()',
  'error Expired()',
  'error BadStart()',
  'error MinTokens()',
  'error ZeroAddress()',
];

const AGENT_REGISTRY_ABI = [
  'function handleOf(address owner) external view returns (string memory)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const ROUTER_ABI = [
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external',
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory)',
];

// ─── Read-only contract interfaces ───────────────────────────────────────────

const mintIface   = new ethers.Interface(MINT_ABI);
const erc20Iface  = new ethers.Interface(ERC20_ABI);
const routerIface = new ethers.Interface(ROUTER_ABI);

function mintContract()    { return new ethers.Contract(ADDR.MINT_CONTRACT,  MINT_ABI,   provider); }
function aiTokenContract() { return new ethers.Contract(ADDR.AI_TOKEN,       ERC20_ABI,  provider); }
function routerContract()  { return new ethers.Contract(ADDR.PANCAKE_ROUTER, ROUTER_ABI, provider); }

let cachedRegistrarAddress: string | null = null;

async function getAgentRegistryContract(): Promise<ethers.Contract | null> {
  try {
    if (!cachedRegistrarAddress) {
      const regAddr = String(await mintContract().registrar());
      if (regAddr && regAddr !== ethers.ZeroAddress) {
        cachedRegistrarAddress = normalizeAddress(regAddr, 'MintSale.registrar');
      }
    }
    return cachedRegistrarAddress
      ? new ethers.Contract(cachedRegistrarAddress, AGENT_REGISTRY_ABI, provider)
      : null;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Failed to resolve MintSale.registrar()');
    return null;
  }
}

// ─── On-chain READS ───────────────────────────────────────────────────────────

export async function readCostOf(shares = 10n): Promise<bigint> {
  return BigInt(await mintContract().costOf(shares));
}

export async function readTotalMinted(): Promise<bigint> {
  return BigInt(await mintContract().totalMinted());
}

export async function readAiBalance(address: string): Promise<bigint> {
  const owner = normalizeAddress(address, 'readAiBalance.owner');
  return BigInt(await aiTokenContract().balanceOf(owner));
}

export async function readAiAllowance(ownerAddress: string, spenderAddress = ADDR.PANCAKE_ROUTER): Promise<bigint> {
  const owner   = normalizeAddress(ownerAddress, 'readAiAllowance.owner');
  const spender = normalizeAddress(spenderAddress, 'readAiAllowance.spender');
  try {
    return BigInt(await aiTokenContract().allowance(owner, spender));
  } catch (err) {
    logger.warn({ owner, spender, err: (err as Error)?.message }, 'readAiAllowance failed — returning 0');
    return 0n;
  }
}

export async function readBnbBalance(address: string): Promise<bigint> {
  const wallet = normalizeAddress(address, 'readBnbBalance.address');
  return await provider.getBalance(wallet);
}

export async function readTxValueWei(txHash: string): Promise<bigint | null> {
  try {
    const tx = await provider.getTransaction(txHash);
    return tx?.value != null ? BigInt(tx.value) : null;
  } catch (err) {
    logger.warn({ txHash, err: (err as Error)?.message }, 'readTxValueWei failed');
    return null;
  }
}

export type ReceiptPollResult =
  | { state: 'confirmed'; receipt: ethers.TransactionReceipt; mintedTokensFromLogs: bigint }
  | { state: 'reverted'; receipt: ethers.TransactionReceipt }
  | { state: 'cancelled' }
  | { state: 'timeout' };

/**
 * Polls BSC (`chainId: 56`) for a transaction receipt at short intervals while
 * respecting user cancellation on every tick. Distinguishes `status === 1`
 * (confirmed, also parsing AI token Transfer logs to `walletAddress`) from
 * `status === 0` (reverted on-chain).
 */
export async function pollTransactionReceipt(
  txHash: string,
  opts?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    walletAddress?: string;
    isCancelled?: () => boolean;
  },
): Promise<ReceiptPollResult> {
  const timeoutMs      = opts?.timeoutMs ?? 90_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 1_500;
  const targetWallet   = opts?.walletAddress
    ? normalizeAddress(opts.walletAddress, 'pollReceipt.walletAddress').toLowerCase()
    : null;
  const aiTokenLower   = ADDR.AI_TOKEN.toLowerCase();
  const deadline       = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts?.isCancelled?.()) return { state: 'cancelled' };

    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        if (receipt.status === 1) {
          let mintedTokensFromLogs = 0n;
          if (targetWallet) {
            for (const log of receipt.logs) {
              if (log.address.toLowerCase() !== aiTokenLower) continue;
              try {
                const parsed = erc20Iface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === 'Transfer') {
                  const toAddr = String(parsed.args[1] ?? '').toLowerCase();
                  if (toAddr === targetWallet) {
                    mintedTokensFromLogs += BigInt(parsed.args[2]);
                  }
                }
              } catch {
                // non-Transfer log — ignore
              }
            }
          }
          logger.info(
            {
              txHash,
              status: 1,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed.toString(),
              mintedTokensFromLogs: mintedTokensFromLogs.toString(),
            },
            'BSC transaction receipt confirmed',
          );
          return { state: 'confirmed', receipt, mintedTokensFromLogs };
        }

        logger.warn(
          {
            txHash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          },
          'BSC transaction receipt reverted on-chain (status=0)',
        );
        return { state: 'reverted', receipt };
      }
    } catch (err) {
      logger.warn({ txHash, err: (err as Error)?.message }, 'getTransactionReceipt transient RPC error — retrying poll');
    }

    // Sleep in short slices so cancellation responds promptly
    const slice = 400;
    let slept = 0;
    while (slept < pollIntervalMs && Date.now() < deadline) {
      if (opts?.isCancelled?.()) return { state: 'cancelled' };
      const step = Math.min(slice, pollIntervalMs - slept);
      await new Promise((r) => setTimeout(r, step));
      slept += step;
    }
  }

  logger.warn({ txHash, timeoutMs }, 'pollTransactionReceipt timed out waiting for receipt');
  return { state: 'timeout' };
}

export async function waitForTxConfirmation(txHash: string, timeoutMs = 30_000): Promise<void> {
  await pollTransactionReceipt(txHash, { timeoutMs });
}

export type OnChainReadResult<T> =
  | { available: true; value: T }
  | { available: false; error: string };

export interface OnChainAgentQuotaInfo {
  available: boolean;
  handle: string;
  agentTokenId: bigint | null;
  ownerValid: boolean;
  mintedCount: bigint;
  quota: bigint;
  remainingQuota: bigint;
}

/**
 * Mirrors MintSale.sol `_agent(address)` + `mintedCount(id)` / `quotaOf(id)`:
 *   registrar.handleOf(wallet) -> id = keccak256(bytes(handle)) -> registrar.ownerOf(id) == wallet.
 */
export async function readOnChainAgentQuota(address: string): Promise<OnChainAgentQuotaInfo> {
  const wallet = normalizeAddress(address, 'readOnChainAgentQuota.address');
  const empty: OnChainAgentQuotaInfo = {
    available: false,
    handle: '',
    agentTokenId: null,
    ownerValid: false,
    mintedCount: 0n,
    quota: 0n,
    remainingQuota: 0n,
  };

  try {
    const registry = await getAgentRegistryContract();
    if (!registry) return empty;

    const rawHandle = String(await registry.handleOf(wallet) ?? '').trim();
    if (!rawHandle) {
      return { ...empty, available: true };
    }

    const tokenId = BigInt(ethers.keccak256(ethers.toUtf8Bytes(rawHandle)));
    let ownerValid = false;
    try {
      const owner = normalizeAddress(String(await registry.ownerOf(tokenId)), 'AgentRegistry.ownerOf');
      ownerValid = owner.toLowerCase() === wallet.toLowerCase();
    } catch {
      ownerValid = false;
    }

    const mint = mintContract();
    const [minted, quota] = await Promise.all([
      mint.mintedCount(tokenId).then((v: unknown) => BigInt(v as bigint | string | number)),
      mint.quotaOf(tokenId).then((v: unknown) => BigInt(v as bigint | string | number)),
    ]);
    const remainingQuota = quota > minted ? quota - minted : 0n;

    return {
      available: true,
      handle: rawHandle,
      agentTokenId: tokenId,
      ownerValid,
      mintedCount: minted,
      quota,
      remainingQuota,
    };
  } catch (err) {
    logger.warn({ walletAddress: wallet, err: (err as Error)?.message }, 'readOnChainAgentQuota failed');
    return empty;
  }
}

export async function readDeveloperMode(_address: string): Promise<OnChainReadResult<boolean>> {
  // Verified MintSale.sol has no on-chain developerModeEnabled() method;
  // Developer Mode is an off-chain Binance Agentic Wallet setting (`baw wallet settings`).
  return { available: false, error: 'Developer Mode is managed in Binance Agentic Wallet settings' };
}

export async function readMintQuota(address: string): Promise<OnChainReadResult<bigint>> {
  const info = await readOnChainAgentQuota(address);
  if (!info.available || !info.ownerValid) {
    return { available: false, error: 'On-chain Agent ID quota unavailable' };
  }
  return { available: true, value: info.remainingQuota };
}

export async function readSpaceIdName(address: string): Promise<string> {
  const info = await readOnChainAgentQuota(address);
  if (!info.available || !info.ownerValid || !info.handle) return '';
  return info.handle.toLowerCase().endsWith('.ai') ? info.handle : `${info.handle}.ai`;
}

// ─── Strong On-Chain Referral & Prior-Completion Eligibility Check ───────────

export type ReferralEligibilityCode =
  | 'ELIGIBLE'
  | 'RESUME_ALLOWED'
  | 'OTHER_REFERRER'
  | 'ALREADY_COMPLETED_OWN_REFERRER'
  | 'CHECK_UNAVAILABLE';

export interface ReferralEligibilityResult {
  eligible: boolean;
  reasonCode: ReferralEligibilityCode;
  message?: string;
  details: {
    walletAddress: string;
    requiredReferrer: string;
    paidOnce: boolean | null;
    boundReferrer: string | null;
    inviteShares: string | null;
    agentHandle: string | null;
    mintedCount: string | null;
    quota: string | null;
    remainingQuota: string | null;
    aiBalance: string | null;
    paused: boolean | null;
  };
}

/**
 * Authoritative on-chain check against verified MintSale.sol storage on BSC (chainId 56):
 *   - `referrerOf(wallet)` (permanently bound on first paid mint; immutable)
 *   - `paidOnce(wallet)` (true once wallet ever completed a paid mint)
 *   - `inviteShares(wallet)`
 *   - `registrar().handleOf(wallet)` + `mintedCount(agentTokenId)` + `quotaOf(agentTokenId)`
 *   - `AI_TOKEN.balanceOf(wallet)` (preserves legitimate post-mint resume under our flow)
 *
 * Blocks wallets that already minted/completed under a different referrer than
 * `0x85377229b28515432cCF1e1c4999BB71C9AdBE11` (`noyonislam.ai`), without causing
 * false positives on fresh wallets or valid unfinished post-mint resumes.
 */
export async function checkWalletReferralEligibility(
  rawWalletAddress: string,
  opts?: { hasLocalUnfinishedMint?: boolean },
): Promise<ReferralEligibilityResult> {
  const walletAddress = normalizeAddress(rawWalletAddress, 'referralCheck.walletAddress');
  const requiredRefLower = ADDR.REFERRER.toLowerCase();

  try {
    const mint = mintContract();
    const [paidOnceRaw, boundRefRaw, inviteSharesRaw, pausedRaw, agentInfo, aiBalance] = await Promise.all([
      mint.paidOnce(walletAddress) as Promise<boolean>,
      mint.referrerOf(walletAddress) as Promise<string>,
      mint.inviteShares(walletAddress).then((v: unknown) => BigInt(v as bigint | string | number)).catch(() => 0n),
      mint.paused().then((v: unknown) => Boolean(v)).catch(() => false),
      readOnChainAgentQuota(walletAddress),
      readAiBalance(walletAddress).catch(() => 0n),
    ]);

    const paidOnce = Boolean(paidOnceRaw);
    const boundReferrer =
      boundRefRaw && boundRefRaw !== ethers.ZeroAddress
        ? normalizeAddress(boundRefRaw, 'MintSale.referrerOf')
        : ethers.ZeroAddress;

    const isBoundToOurReferrer =
      boundReferrer !== ethers.ZeroAddress && boundReferrer.toLowerCase() === requiredRefLower;
    const isBoundToOtherReferrer =
      boundReferrer !== ethers.ZeroAddress && boundReferrer.toLowerCase() !== requiredRefLower;
    const isResumingOurFlow =
      aiBalance > 0n && (isBoundToOurReferrer || Boolean(opts?.hasLocalUnfinishedMint));
    const isQuotaExhausted =
      agentInfo.available && agentInfo.ownerValid && agentInfo.quota > 0n && agentInfo.remainingQuota < 10n;

    const details = {
      walletAddress,
      requiredReferrer: ADDR.REFERRER,
      paidOnce,
      boundReferrer: boundReferrer === ethers.ZeroAddress ? null : boundReferrer,
      inviteShares: inviteSharesRaw.toString(),
      agentHandle: agentInfo.handle || null,
      mintedCount: agentInfo.available ? agentInfo.mintedCount.toString() : null,
      quota: agentInfo.available ? agentInfo.quota.toString() : null,
      remainingQuota: agentInfo.available ? agentInfo.remainingQuota.toString() : null,
      aiBalance: ethers.formatUnits(aiBalance, 18),
      paused: pausedRaw,
    };

    let result: ReferralEligibilityResult;

    if (isBoundToOtherReferrer) {
      result = {
        eligible: false,
        reasonCode: 'OTHER_REFERRER',
        message: OTHER_REFERRER_INELIGIBLE_MESSAGE,
        details,
      };
    } else if (paidOnce && !isBoundToOurReferrer && !isResumingOurFlow) {
      // Wallet already completed a paid mint on-chain without our referrer (e.g. direct/0x0 or other ref)
      result = {
        eligible: false,
        reasonCode: 'OTHER_REFERRER',
        message: OTHER_REFERRER_INELIGIBLE_MESSAGE,
        details,
      };
    } else if (isQuotaExhausted && !isBoundToOurReferrer && !isResumingOurFlow) {
      // Agent ID quota already consumed outside our referral
      result = {
        eligible: false,
        reasonCode: 'OTHER_REFERRER',
        message: OTHER_REFERRER_INELIGIBLE_MESSAGE,
        details,
      };
    } else if (isResumingOurFlow) {
      result = {
        eligible: true,
        reasonCode: 'RESUME_ALLOWED',
        details,
      };
    } else if (isBoundToOurReferrer && isQuotaExhausted && aiBalance === 0n) {
      // Already completed mint + sell under OUR referrer (even if local DB was reset)
      result = {
        eligible: false,
        reasonCode: 'ALREADY_COMPLETED_OWN_REFERRER',
        details,
      };
    } else {
      result = {
        eligible: true,
        reasonCode: 'ELIGIBLE',
        details,
      };
    }

    logger.info(
      { ...details, eligible: result.eligible, reasonCode: result.reasonCode },
      'On-chain referral & mint eligibility check',
    );
    return result;
  } catch (err) {
    logger.warn(
      { walletAddress, err: (err as Error)?.message ?? String(err) },
      'checkWalletReferralEligibility RPC failed — skipping hard block to avoid false positive',
    );
    return {
      eligible: true,
      reasonCode: 'CHECK_UNAVAILABLE',
      details: {
        walletAddress,
        requiredReferrer: ADDR.REFERRER,
        paidOnce: null,
        boundReferrer: null,
        inviteShares: null,
        agentHandle: null,
        mintedCount: null,
        quota: null,
        remainingQuota: null,
        aiBalance: null,
        paused: null,
      },
    };
  }
}

/** True when the candidate is a non-empty *.ai SPACE ID Agent name (e.g. dadyjisan.ai). */
export function isValidAiAgentId(name?: string | null): boolean {
  if (typeof name !== 'string') return false;
  return /^[^\s]+\.ai$/i.test(name.trim());
}

// ─── Sell simulation ──────────────────────────────────────────────────────────

/**
 * Simulates the AI → BNB sell and returns expected BNB output.
 *
 * Uses getAmountsOut + 15% fee discount because the AI token charges a
 * transfer fee that getAmountsOut cannot see (it queries the pool reserve
 * ratio but not the token's own fee). The 15% discount keeps our simulated
 * output below real proceeds so the 8% stop-loss check is conservative.
 */
export async function simulateSellOutput(aiAmount: bigint): Promise<bigint> {
  if (aiAmount === 0n) return 0n;
  try {
    const router = routerContract();
    const amounts: bigint[] = await router.getAmountsOut(aiAmount, [ADDR.AI_TOKEN, ADDR.WBNB]);
    const nominal    = BigInt(amounts[1]);
    const discounted = (nominal * 85n) / 100n; // 15% conservative discount for AI transfer fee
    logger.debug({ nominal: nominal.toString(), discounted: discounted.toString() }, 'simulateSellOutput');
    return discounted;
  } catch (e) {
    logger.warn({ err: e }, 'simulateSellOutput failed — returning 0');
    return 0n;
  }
}

// ─── Preflight checks ─────────────────────────────────────────────────────────

export interface PreflightBawSettings {
  devModeEnabled: boolean | null;
  devModeExpiresAt: string | null;
  devModeExpired: boolean;
  devModeDailyLimit: number;
  devModeQuotaUsed: number | null;
  devModeBalanceExceeded: boolean;
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  rawDevMode?: unknown;
}

export interface PreflightContext {
  sessionAgentId?: string | null;
  dbAgentId?: string | null;
  bawAgentId?: string | null;
  bawSettings?: PreflightBawSettings | null;
  bawSettingsError?: string | null;
  /** True when resuming an already-minted AI token balance (only gas buffer needed, not another mintCost). */
  skipMintCostBalanceCheck?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  resolvedAgentId?: string;
}

/** Minimum BNB recommended (~0.08 BNB covers mint cost + gas buffer) */
export const GAS_BUFFER        = ethers.parseEther('0.01');
export const RESUME_GAS_BUFFER = ethers.parseEther('0.005');
export const MIN_BNB           = ethers.parseEther('0.08');

export async function runPreflightChecks(
  rawWalletAddress: string,
  mintCostWei: bigint,
  ctx?: PreflightContext,
): Promise<PreflightResult> {
  const walletAddress = normalizeAddress(rawWalletAddress, 'preflight.walletAddress');
  const [bnbBal, onChainSpaceId, onChainDevMode, onChainQuota] = await Promise.all([
    readBnbBalance(walletAddress),
    readSpaceIdName(walletAddress),
    readDeveloperMode(walletAddress),
    readMintQuota(walletAddress),
  ]);

  const onChainName = onChainSpaceId.trim();
  const bawName     = ctx?.bawAgentId?.trim() ?? '';
  const sessionName = ctx?.sessionAgentId?.trim() ?? '';
  const dbName      = ctx?.dbAgentId?.trim() ?? '';

  // Resolve *.ai Agent ID:
  // 1. On-chain readSpaceIdName (if valid *.ai)
  // 2. Live baw wallet agent-id lookup (if valid *.ai)
  // 3. In-memory bound session agentIdName (if valid *.ai)
  // 4. Persisted Supabase users.agent_id_name (if valid *.ai)
  let resolvedAgentId = '';
  let agentIdSource: 'onchain' | 'baw' | 'session' | 'db' | 'none' = 'none';

  if (isValidAiAgentId(onChainName)) {
    resolvedAgentId = onChainName;
    agentIdSource   = 'onchain';
  } else if (isValidAiAgentId(bawName)) {
    resolvedAgentId = bawName;
    agentIdSource   = 'baw';
  } else if (isValidAiAgentId(sessionName)) {
    resolvedAgentId = sessionName;
    agentIdSource   = 'session';
  } else if (isValidAiAgentId(dbName)) {
    resolvedAgentId = dbName;
    agentIdSource   = 'db';
  }

  // Evaluate Developer Mode:
  // Developer Mode is an off-chain Binance Agentic Wallet setting (`baw wallet settings --json`),
  // NOT a Solidity method on the BSC mint contract. Check `bawSettings` first; fall back to
  // on-chain `developerModeEnabled(address)` only if that view call actually exists on-chain.
  const bawSettings = ctx?.bawSettings ?? null;
  let devModeSource: 'baw_settings' | 'onchain' | 'unavailable' = 'unavailable';
  let devModeEnabled: boolean | null = null;

  if (bawSettings && bawSettings.devModeEnabled !== null) {
    devModeSource  = 'baw_settings';
    devModeEnabled = bawSettings.devModeEnabled && !bawSettings.devModeExpired;
  } else if (onChainDevMode.available) {
    devModeSource  = 'onchain';
    devModeEnabled = onChainDevMode.value;
  }

  logger.info(
    {
      walletAddress,
      onChainSpaceId: onChainName || null,
      bawAgentId: bawName || null,
      sessionAgentId: sessionName || null,
      dbAgentId: dbName || null,
      resolvedAgentId: resolvedAgentId || null,
      agentIdSource,
      bnbBalance: ethers.formatEther(bnbBal),
      devModeCheck: {
        source: devModeSource,
        evaluatedEnabled: devModeEnabled,
        bawRawDevMode: bawSettings?.rawDevMode ?? null,
        bawDevModeExpired: bawSettings?.devModeExpired ?? false,
        bawDevModeBalanceExceeded: bawSettings?.devModeBalanceExceeded ?? false,
        bawSettingsError: ctx?.bawSettingsError ?? null,
        onChainAvailable: onChainDevMode.available,
        onChainValue: onChainDevMode.available ? onChainDevMode.value : null,
      },
      quotaCheck: {
        bawDevModeDailyLimit: bawSettings?.devModeDailyLimit ?? null,
        bawDevModeQuotaUsed: bawSettings?.devModeQuotaUsed ?? null,
        bawDailyLimit: bawSettings?.dailyLimit ?? null,
        bawQuotaLeft: bawSettings?.quotaLeft ?? null,
        onChainAvailable: onChainQuota.available,
        onChainValue: onChainQuota.available ? onChainQuota.value.toString() : null,
      },
    },
    'Preflight Agent ID, Developer Mode & chain state check',
  );

  const boundCandidate = bawName || sessionName || dbName;
  if (
    onChainName &&
    boundCandidate &&
    onChainName.toLowerCase() !== boundCandidate.toLowerCase()
  ) {
    logger.warn(
      { walletAddress, onChainSpaceId: onChainName, boundAgentId: boundCandidate, resolvedAgentId },
      'Preflight: on-chain spaceIdAiName differs from bound/session Agent ID',
    );
  }

  const needed = ctx?.skipMintCostBalanceCheck ? RESUME_GAS_BUFFER : mintCostWei + GAS_BUFFER;
  if (bnbBal < needed) {
    return {
      ok: false,
      resolvedAgentId: resolvedAgentId || undefined,
      reason: ctx?.skipMintCostBalanceCheck
        ? `Insufficient BNB for approve/sell gas. Need ≥ ${ethers.formatEther(needed)} BNB (have ${ethers.formatEther(bnbBal)} BNB).`
        : `Insufficient BNB. Need ≥ ${ethers.formatEther(needed)} BNB (have ${ethers.formatEther(bnbBal)} BNB). ` +
          `Minimum recommended: ${ethers.formatEther(MIN_BNB)} BNB.`,
    };
  }
  if (!resolvedAgentId) {
    return {
      ok: false,
      reason: 'No SPACE ID AI name (*.ai) on this wallet. Register one in the SPACE ID AI dashboard first.',
    };
  }

  if (devModeSource === 'baw_settings' && bawSettings) {
    if (bawSettings.devModeEnabled === false) {
      return {
        ok: false,
        resolvedAgentId,
        reason:
          'Developer mode is not enabled in your Binance Agentic Wallet. ' +
          'Enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
      };
    }
    if (bawSettings.devModeExpired) {
      return {
        ok: false,
        resolvedAgentId,
        reason:
          `Developer mode expired (${bawSettings.devModeExpiresAt ?? 'past expiry'}). ` +
          'Re-enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
      };
    }
    if (bawSettings.devModeBalanceExceeded) {
      return {
        ok: false,
        resolvedAgentId,
        reason:
          'Developer mode balance limit is exceeded in your Binance Agentic Wallet settings. ' +
          'Review your Developer Mode settings in the Binance App.',
      };
    }
  } else if (devModeSource === 'onchain') {
    if (!devModeEnabled) {
      return {
        ok: false,
        resolvedAgentId,
        reason: 'Developer mode is not enabled. Enable it in Binance App → Agentic Wallet → Settings → Developer Mode.',
      };
    }
  } else {
    // Neither baw settings nor on-chain read could confirm Developer Mode state.
    return {
      ok: false,
      resolvedAgentId,
      reason:
        `Could not verify Developer Mode status from Binance Agentic Wallet` +
        (ctx?.bawSettingsError ? ` (${ctx.bawSettingsError.slice(0, 120)})` : '') +
        '. Ensure Developer Mode is enabled in Binance App → Agentic Wallet → Settings → Developer Mode and try again.',
    };
  }

  // Quota check:
  // 1. Binance Agentic Wallet Developer Mode daily USD quota
  if (
    bawSettings &&
    bawSettings.devModeDailyLimit > 0 &&
    bawSettings.devModeQuotaUsed != null &&
    bawSettings.devModeQuotaUsed >= bawSettings.devModeDailyLimit
  ) {
    return {
      ok: false,
      resolvedAgentId,
      reason:
        `Developer Mode daily quota exhausted ($${bawSettings.devModeQuotaUsed.toFixed(2)} / $${bawSettings.devModeDailyLimit.toFixed(2)}). ` +
        'Increase your Developer Mode daily limit in the Binance App or wait for daily reset.',
    };
  }
  // 2. General daily trading limit from baw settings
  if (bawSettings && bawSettings.dailyLimit > 0 && bawSettings.quotaLeft <= 0) {
    return {
      ok: false,
      resolvedAgentId,
      reason: 'Daily trading quota exhausted in Binance Agentic Wallet. Wait for daily quota reset.',
    };
  }
  // 3. On-chain MintSale Agent ID quota (skip when resuming an already-minted balance for Approve → Sell)
  if (!ctx?.skipMintCostBalanceCheck && onChainQuota.available && onChainQuota.value < 10n) {
    return {
      ok: false,
      resolvedAgentId,
      reason: `Mint quota exhausted on-chain (remaining: ${onChainQuota.value.toString()} shares, need 10).`,
    };
  }

  return { ok: true, resolvedAgentId };
}

// ─── Calldata builders (for baw contract-call) ────────────────────────────────

/**
 * Returns live mint parameters + 0x calldata ready for baw contract-call.
 * Re-reads totalMinted() and costOf() on every call so expectedStart is fresh.
 */
export async function buildMintCalldata(shares = 10n): Promise<{
  inputData: string;
  value: bigint;      // wei — tx value = maxCost (pays for mint)
  maxCost: bigint;
  expectedStart: bigint;
}> {
  const [maxCost, totalMintedNow] = await Promise.all([
    readCostOf(shares),
    readTotalMinted(),
  ]);
  const expectedStart = totalMintedNow + 1n;
  const deadline      = BigInt(Math.floor(Date.now() / 1000) + 600);

  const inputData = mintIface.encodeFunctionData('mint', [
    shares,
    ADDR.REFERRER,  // noyonislam.ai — never change
    maxCost,
    expectedStart,
    0n,             // minTokens
    deadline,
  ]);

  logger.debug({ maxCost: maxCost.toString(), expectedStart: expectedStart.toString() }, 'buildMintCalldata');
  return { inputData, value: maxCost, maxCost, expectedStart };
}

/**
 * Returns approve calldata for exact AI token amount to PancakeSwap Router.
 * No over-approval — amount is the exact tokensReceived from mint.
 */
export function buildApproveCalldata(amount: bigint): string {
  const spender = normalizeAddress(ADDR.PANCAKE_ROUTER, 'approve.spender');
  return erc20Iface.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Returns swapExactTokensForETHSupportingFeeOnTransferTokens calldata.
 * amountOutMin = 0 — executes instant market-price sell at current PancakeSwap V2 rate.
 */
export function buildSellCalldata(aiAmount: bigint, walletAddress: string): string {
  const recipient = normalizeAddress(walletAddress, 'sell.recipient');
  const tokenIn   = normalizeAddress(ADDR.AI_TOKEN, 'sell.tokenIn');
  const tokenOut  = normalizeAddress(ADDR.WBNB, 'sell.tokenOut');
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 600);
  return routerIface.encodeFunctionData(
    'swapExactTokensForETHSupportingFeeOnTransferTokens',
    [aiAmount, 0n, [tokenIn, tokenOut], recipient, deadline],
  );
}

/** Checks if a revert error is a mint race (expectedStart mismatch: 0x5fb01790) */
export function isMintRaceError(err: unknown): boolean {
  const e = err as { data?: string; message?: string } | null;
  return !!(
    e?.data?.includes('5fb01790') ||
    e?.message?.includes('5fb01790') ||
    e?.message?.toLowerCase().includes('expectedstart')
  );
}

/** Checks if a mint failure was caused by a live price increase between read & submission */
export function isMintPriceMismatchError(err: unknown): boolean {
  const e = err as { message?: string } | null;
  const msg = (e?.message ?? '').toLowerCase();
  return /maxcost|insufficient.*(value|payment|eth|bnb)|price.*(changed|increased|exceeded)|underpriced.*mint/i.test(msg);
}

export interface RpcSimulationResult {
  ok: boolean;
  estimatedGas?: bigint;
  isRevert?: boolean;
  revertData?: string;
  revertReason?: string;
  error?: string;
}

/**
 * Runs a read-only BSC RPC `eth_estimateGas` simulation before calling `baw`.
 * Surfaces real contract reverts (e.g. 0x5fb01790 expectedStart race or custom errors)
 * and provides an on-chain gas estimate for diagnostics and buffered retry if needed.
 */
export async function simulateContractCall(opts: {
  step: string;
  from: string;
  to: string;
  data: string;
  value?: bigint;
}): Promise<RpcSimulationResult> {
  const { step, data, value = 0n } = opts;
  const from = normalizeAddress(opts.from, `${step}.from`);
  const to   = normalizeAddress(opts.to, `${step}.to`);
  const fnSelector = data.slice(0, 10);

  try {
    const estimatedGas = await provider.estimateGas({ from, to, data, value });
    logger.info(
      {
        step,
        to,
        fnSelector,
        valueBnb: ethers.formatEther(value),
        estimatedGas: estimatedGas.toString(),
      },
      'BSC RPC estimateGas succeeded',
    );
    return { ok: true, estimatedGas };
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      data?: string;
      reason?: string;
      shortMessage?: string;
      message?: string;
      info?: { error?: { data?: string; message?: string } };
    };
    const revertData =
      typeof e?.data === 'string' && e.data.startsWith('0x') && e.data.length > 2
        ? e.data
        : typeof e?.info?.error?.data === 'string' && e.info.error.data.startsWith('0x') && e.info.error.data.length > 2
          ? e.info.error.data
          : undefined;
    const rawMsg = e?.shortMessage ?? e?.message ?? String(err);
    let decodedCustomError: string | undefined;
    if (revertData) {
      try {
        const parsed = mintIface.parseError(revertData);
        if (parsed?.name) decodedCustomError = `${parsed.name}()`;
      } catch {
        // not a known MintSale custom error
      }
    }
    const revertReason =
      decodedCustomError ??
      e?.reason ??
      e?.info?.error?.message ??
      (revertData ? `custom error ${revertData.slice(0, 10)}` : undefined);

    const isRevert = Boolean(
      e?.code === 'CALL_EXCEPTION' ||
      revertData ||
      /revert|execution reverted|invalid opcode/i.test(rawMsg),
    );

    logger.warn(
      {
        step,
        to,
        fnSelector,
        valueBnb: ethers.formatEther(value),
        code: e?.code ?? null,
        isRevert,
        revertData: revertData ? revertData.slice(0, 74) : null,
        revertReason: revertReason ?? null,
        error: rawMsg.slice(0, 240),
      },
      'BSC RPC estimateGas failed',
    );

    return {
      ok: false,
      isRevert,
      revertData,
      revertReason,
      error: rawMsg,
    };
  }
}

/** Returns gasPrice for LOW/MEDIUM priority (+5% above base) */
export async function getLowGasPrice(): Promise<bigint> {
  const feeData = await provider.getFeeData();
  const base = feeData.gasPrice != null ? BigInt(feeData.gasPrice) : ethers.parseUnits('3', 'gwei');
  return (base * 105n) / 100n;
}
