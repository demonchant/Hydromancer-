# Hydromancer

Hydromancer is a read only Hyperliquid risk monitor built for the Crypto World's Fair Hyperliquid track. Anyone can open the deployed app, start a private session without email or password, enter a public Hyperliquid address, and use the live monitor.

## The problem

Traders can see positions and liquidation levels in exchange interfaces, but they may not notice when a position moves close to its reported liquidation price. A normal price alert does not account for a trader's position direction or its individual liquidation level. A monitor must also show whether the account data and market price are current.

## How Hydromancer helps

Hydromancer reads the public account state and live market prices from Hyperliquid. It calculates the distance from each open position's live mid price to the liquidation price returned by Hyperliquid, highlights the nearest distance, and compares it with the user's chosen threshold. It stores a warning or recovery event when that threshold changes state.

It does not estimate liquidation prices. If the exchange does not return the required fields, the signal is unavailable. It never requests a wallet connection, seed phrase, private key, or trading permission. It cannot sign or place trades.

## Try it

1. Open the deployed site.
2. Choose **Monitor an account**, then **Continue privately**.
3. Complete the security check if it appears.
4. Enter a public Hyperliquid account address you are allowed to inspect.
5. Review positions, live prices, liquidation distance, threshold settings, freshness, and activity history.

Each visitor gets a private Supabase anonymous session. The monitor and events are isolated by row level security. The session is stored in the browser; clearing browser data or changing devices means the visitor cannot recover that same private session. No example account or simulated market data is used.

## What happens behind the screen

```text
Public address
  -> Hyperliquid clearinghouseState
  -> Hyperliquid allMids WebSocket and REST snapshot
  -> nearest position liquidation distance
  -> private Supabase monitor and activity history
  -> Supabase Cron invokes the protected background monitor
```

The browser refreshes account state every 15 seconds and reconnects to the public market feed when needed. Supabase Cron checks saved monitors every minute. Server events are recorded atomically so one threshold crossing does not create repeated warning events. The recovery event waits until the distance clears the threshold by two percentage points.

## Business hypothesis

The initial users are active Hyperliquid traders who want position specific risk monitoring outside the exchange screen. A future business could offer free monitoring for individual traders and paid multi account workspaces, longer event history, and team alerts for trading groups. Pricing, willingness to pay, and the size of this market have not been validated; we will not present them as established facts.

## Data accuracy and limits

- Market prices and account positions come from the live Hyperliquid mainnet public API.
- The distance formula uses Hyperliquid's returned liquidation price and current mid price, with position direction accounted for.
- A displayed distance is an observation, not a liquidation guarantee or financial advice.
- The margin tile shows the cross maintenance margin field returned by Hyperliquid. It does not claim to describe every isolated position's margin.
- In local mode without Supabase configuration, monitoring and event history stay in that browser and stop when the page closes.
- Server checks require the Supabase project, database migration, Edge Function, and Cron job to be configured and deployed.

## Run locally

Requirements: Node.js 20 or newer and npm.

```powershell
npm install
npm run dev
```

The public account and market reads work without environment variables. To enable private sessions and background checks, create `.env.local` in the project root with your Supabase project URL, publishable key, and Cloudflare Turnstile site key:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
VITE_TURNSTILE_SITE_KEY=YOUR_TURNSTILE_SITE_KEY
```

These values are local development configuration. `.env.local` is ignored by Git and must never be committed. The Turnstile secret and monitor cron secret belong in the Supabase dashboard or Vault, never in the browser.

## Build and verify

```powershell
npm run build
npm run test
npm run preview
```

## Deploy

Deploy the Vite app to Vercel with the three `VITE_` values above. Apply the SQL migration in `supabase/migrations`, deploy `supabase/functions/monitor`, and install the Cron job from `supabase/setup-cron.sql`. The full setup, account security, and verification steps are in [the deployment guide](docs/deployment-and-secrets.md).

Never expose `MONITOR_CRON_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` in a client environment variable. Supabase supplies its service key to the Edge Function runtime. No Hyperliquid key or trading secret is needed.

## Hackathon fit

Hydromancer integrates with HyperCore through Hyperliquid's public account information endpoint and live WebSocket feed. It is designed around the Crypto World's Fair judging areas: working software, trader impact, a position aware signal, a clear user flow, open source code, and a focused business hypothesis. Product claims remain limited to behavior that can be demonstrated with real data. The entrant must complete registration, rule acceptance, eligibility review, and project submission on Colosseum.

## License

Hydromancer is released under the MIT License. See [LICENSE](LICENSE).
