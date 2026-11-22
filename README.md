# Binance Agentic TG Bot

A public, portable Telegram bot that automates BNB Smart Chain (`chainId: 56`) AI token minting, exact PancakeSwap V2 approval, and fee-on-transfer selling via each user's non-custodial **Binance Agentic Wallet** (`@binance/agentic-wallet` / `baw`), with Gemini AI handling natural-language intent routing and end-of-cycle summaries.

---

## Fixed Referrer Policy

Every mint transaction automatically uses the hardcoded referrer (never `0x0`, never user-overridden) and displays it immediately on `/start`:

- **Referrer Code / Agent ID:** `noyonislam.ai`
- **Referrer Address:** `0x85377229b28515432cCF1e1c4999BB71C9AdBE11`

---

## Folder Structure

```
binance-agentic-tg-bot/
├── src/
│   ├── config.ts              # Env validation, multi-ADMIN_ID parsing, portable paths
│   ├── logger.ts              # Pino structured logger with safe pino-pretty fallback
│   ├── db.ts                  # PostgreSQL pool (auto-SSL), schema bootstrap, user & admin queries
│   ├── bsc.ts                 # Layer 2: BSC RPC reads, preflight checks & calldata builders
│   ├── wallet.ts              # Layer 1: @binance/agentic-wallet (baw) MPC signing & session binding
│   ├── gemini.ts              # Gemini AI intent router + plain-text final summary (free-tier safe)
│   ├── qr.ts                  # QR code PNG generator
│   ├── executor.ts            # Layer 3: Deterministic Mint → Approve → Sell cycle engine
│   ├── keyboards.ts           # Telegraf inline keyboard layouts (role-aware)
│   ├── index.ts               # Layer 4/5: Bot entry point, commands, /health server, graceful shutdown
│   └── handlers/
│       ├── start.ts           # /start welcome + fixed referrer notice
│       ├── wallet.ts          # /connect & Connect Wallet pairing flow
│       ├── qr.ts              # Generate QR Code from stored pairing URI
│       ├── execute.ts         # /mint & Complete All Process live-updating handler + admin alerts
│       ├── jobs.ts            # /status & /my_jobs personal status view (own data only)
│       ├── cancel.ts          # Cancel & session reset
│       ├── admin.ts           # /admin, /admin_completed, /admin_incomplete, /admin_users (ADMIN_ID only)
│       └── message.ts         # Free-text → Gemini intent routing
├── schema.sql                 # Supabase/PostgreSQL schema (idempotent)
├── package.json
├── package-lock.json
├── tsconfig.json
├── railway.toml               # Railway deploy config
├── nixpacks.toml              # Render / Railway Nixpacks build config
├── .env.example               # Environment variable template (no secrets)
├── .gitignore
└── README.md
```

> **Excluded from repository / GitHub uploads:**
> `node_modules/` (installed via `npm ci`), `dist/` (compiled via `npm run build`), `.env` (created per environment from `.env.example`).

---

## Environment Variables

Copy `.env.example` to `.env` locally, or configure these variables in your host (Railway, Render, Docker, VPS):

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ Yes | — | Google AI Studio API key |
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | — | Telegram bot token from `@BotFather` |
| `SUPABASE_DB_URL` | ✅ Yes | — | PostgreSQL connection string (SSL auto-enabled for non-local hosts; set `sslmode=disable` if not using SSL) |
| `ADMIN_ID` | ✅ Yes | — | Primary Telegram numeric admin user ID (also accepts comma-separated IDs, e.g. `12345,67890`) |
| `BSC_RPC_URL` | ✅ Yes | — | BSC mainnet (`chainId: 56`) RPC URL, e.g. `https://bsc-dataseed1.binance.org/` |
| `ADMIN_IDS` | ☑️ Optional | — | Additional comma-separated admin Telegram user IDs (merged with `ADMIN_ID`) |
| `BAW_SESSION_ROOT` | ☑️ Optional | `~/.baw-sessions` | Directory root for per-user `baw` sessions (`<root>/<userId>/`). Derived via `os.homedir()` by default |
| `LOG_LEVEL` | ☑️ Optional | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `PORT` | ☑️ Optional | `3000` | HTTP health-check server port (`GET /health`) |
| `NODE_ENV` | ☑️ Optional | — | Set to `production` for structured JSON logs |
| `SUPABASE_URL` | ☑️ Optional | — | Supabase REST API URL (reserved for extensions) |
| `SUPABASE_SERVICE_ROLE_KEY` | ☑️ Optional | — | Supabase service role key (reserved for extensions) |

---

## Contracts & Addresses (BSC Mainnet — chainId 56)

| Name | Address |
|---|---|
| SPACE ID AI Mint | `0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D` |
| AI Token (ERC-20) | `0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924f` |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| Referrer (hardcoded) | `0x85377229b28515432cCF1e1c4999BB71C9AdBE11` (`noyonislam.ai`) |

---

## Running on Any System (Linux / macOS / Windows)

### Prerequisites
- Node.js `>= 18`
- PostgreSQL 14+ or Supabase database
- Required environment variables configured

### Setup & Run

```bash
# 1. Install exact dependencies (including @binance/agentic-wallet CLI & TypeScript)
npm ci

# 2. Configure environment
cp .env.example .env
# Edit .env with your real credentials

# 3. (Optional) Apply SQL schema + indexes once
psql "$SUPABASE_DB_URL" -f schema.sql

# 4. Type-check and build
npm run typecheck
npm run build

# 5. Start
npm start
```

Health check endpoint: `GET http://localhost:<PORT>/health` returns:
```json
{ "status": "ok", "db": "connected", "baw": "ready", "uptime": 42 }
```

If the database is temporarily unreachable at startup, the bot starts in **degraded mode**, logs the full error + stack trace, and surfaces clear status messages instead of crash-looping.

---

## Bot Commands & Role Separation

### Normal User Commands (Own Data Only)
| Trigger | Action |
|---|---|
| `/start` | Welcome message with hardcoded referrer (`noyonislam.ai` / `0x85377229...`) and main menu |
| `/connect` or `🔗 Connect Your Binance Wallet` | Start real `baw auth signin` pairing flow, send scannable QR, and bind session automatically |
| `📱 Generate QR Code` | Re-render QR strictly from the user's stored pairing session URI |
| `/mint` or `🚀 Complete All Process` | Run deterministic preflight → live-price mint → exact approve → instant market-price sell (with continuous retry until confirmed) |
| `/status`, `/my_jobs`, or `📊 My Status & Jobs` | View **only your own** wallet connection, bound `.ai` Agent ID, completed cycle count/history, and incomplete/failed/stopped attempt counts |
| `❌ Cancel` | Request stop at next safe checkpoint and reset/sign out session |

### Admin Commands (Strictly Restricted to `ADMIN_ID` / `ADMIN_IDS`)
| Command / Button | Action |
|---|---|
| `/admin` or `🛡️ Admin Dashboard` | Overview across all users: total users, connected wallets, completed cycles, unique completed Agent IDs, connected-only accounts, and incomplete attempt breakdown |
| `/admin_completed` | Total count and full list of all Agent IDs (`*.ai` / wallet records) and users who completed the full `mint + approve + sell` cycle |
| `/admin_incomplete` | Count and list of Agent IDs / wallets that only connected (`is_wallet_connected`) OR did not complete the cycle (pending, stopped, failed, session expired, cancelled) with last reason |
| `/admin_users` | All registered users with connection status, bound Agent ID, completed count, incomplete count, and join date |
| `/admin_stop` or `/stop_bot` | Stop the bot for all normal users (persisted in `bot_settings`; admin retains full access) |
| `/admin_start` or `/start_bot` | Turn the bot back ON for all users |

Non-admin users attempting any admin command or callback immediately receive `⛔ Unauthorized.` with zero data exposed.

---

## Deployment (Railway / Render / GitHub Drag-and-Drop)

Upload only the clean source files (never `node_modules/`, `dist/`, or `.env`). `nixpacks.toml` and `railway.toml` keep install and build phases cleanly separated (preventing Nixpacks `EBUSY` on `/app/node_modules/.cache`):
- **Install phase (`nixpacks.toml`):** `npm ci --include=dev`
- **Build phase (`railway.toml` / `nixpacks.toml`):** `npm run build` (`tsc` → `dist/index.js`)
- **Start:** `npm start` (`node dist/index.js`)
- **Health check:** `GET /health`

---

## Security & Rules

- 🔒 Non-custodial signing via `@binance/agentic-wallet` (`baw`) MPC — never requests seed phrases or private keys
- 🔒 Per-user isolated `baw` session directories (`<BAW_SESSION_ROOT>/<userId>/`) and per-user serial execution locks
- 🔒 Never asks users to send BNB directly to a contract address
- 🔒 Exact ERC-20 token approval to PancakeSwap V2 Router (no unlimited approvals)
- 🔒 Instant market-price sell on PancakeSwap V2 with dynamic gas buffering and automatic retry until confirmed (stopping on user cancel, expired session, or zero AI balance)
- 🔒 Hardcoded referrer `0x85377229b28515432cCF1e1c4999BB71C9AdBE11` (`noyonislam.ai`) on every mint
- 🔒 Admin views strictly gated by numeric `ADMIN_IDS` check

## License

MIT
