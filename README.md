# Hydromancer

Hydromancer is a read only Hyperliquid risk monitor built for the Crypto World's Fair Hyperliquid track. Anyone can open the deployed app, start a private session without email or password, enter a public Hyperliquid address, and use the live monitor.

## The problem

Traders can see positions and liquidation levels in exchange interfaces, but they may not notice when a position moves close to its reported liquidation price. A normal price alert does not account for a trader's position direction or its individual liquidation level. A monitor must also show whether the account data and market price are current.

## How Hydromancer helps

Hydromancer reads public account state and Hyperliquid mark prices. It calculates each open position's distance from the liquidation price returned by Hyperliquid, highlights the nearest distance, and compares it with the user's chosen threshold. This uses mark price because Hyperliquid uses mark price for liquidations; mid prices are shown separately as reference values. It stores a warning or recovery event when that threshold changes state.

It does not estimate liquidation prices. If the exchange does not return the required fields, the signal is unavailable. It never requests a wallet connection, seed phrase, private key, or trading permission. It cannot sign or place trades.

## Try it

1. Open the [deployed Hydromancer site](https://hydromancer.vercel.app/).
2. Choose **Monitor an account**, then **Continue privately**.
3. Complete the security check if it appears.
4. Enter a public Hyperliquid account address you are allowed to inspect.
5. Review positions, live prices, liquidation distance, threshold settings, freshness, and activity history.

Each visitor gets a private Supabase anonymous session. The monitor and events are isolated by row level security. The session is stored in the browser; clearing browser data or changing devices means the visitor cannot recover that same private session. No example account or simulated market data is used.

## What happens behind the screen

```text
Public address
  -> Hyperliquid clearinghouseState
  -> Hyperliquid mark price contexts and per position activeAssetCtx WebSocket feeds
  -> allMids reference feed
  -> nearest position liquidation distance
  -> private Supabase monitor and activity history
  -> Supabase Cron invokes the protected background monitor
```

The browser refreshes account state every 15 seconds, obtains a mark price context snapshot, and subscribes to mark price streams for the account's open positions. A mark observation expires after 30 seconds without an update, and account state older than 30 seconds is unavailable for risk scoring. If any open position lacks a fresh mark or a reported liquidation price, the dashboard shows partial data and pauses alerts rather than treating the remaining positions as a complete risk view. Supabase Cron checks saved monitors every minute using mark price contexts and also skips risk transitions for incomplete account data. Server events are recorded atomically so one threshold crossing does not create repeated warning events. The recovery event waits until the distance clears the threshold by two percentage points.

## Business hypothesis

The initial customer hypothesis is an active Hyperliquid perpetual trader managing multiple open positions or needing risk visibility while away from the exchange screen. The product wedge is not another price alert: it ranks each position using the mark price used by Hyperliquid for liquidations, and suppresses the distance when that input is stale.

The founder trades on Hyperliquid and built Hydromancer from a risk visibility problem experienced firsthand. This gives the project direct founder problem fit; it does not establish broader demand.

The first distribution test is a public free monitor shared with relevant Hyperliquid trader communities. Before paid tiers, interview consenting traders and measure setup completion, whether they understand the distance correctly, return use after seven days, alert usefulness, and willingness to pay. A free individual monitor and paid multi account or team history are pricing hypotheses only. No external user, conversion, retention, revenue, or market size claim is made until measured.

## Data accuracy and limits

- Market prices and account positions come from the live Hyperliquid mainnet public API.
- The distance formula uses Hyperliquid's returned liquidation price and current mark price, with position direction accounted for.
- Mid prices are displayed as separate reference prices and are not used for liquidation distance.
- Position values, entry prices, and PnL that the exchange does not provide remain unavailable instead of displaying a fabricated zero.
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

Judges can reproduce the automated checks from the repository root with `npm ci`, `npm.cmd run test`, and `npm.cmd run build` (or the equivalent `npm run` commands on Unix-like shells). The test and build details, scope, and manual integration checklist are in [docs/TESTING.md](docs/TESTING.md). Real trader feedback can be recorded in [docs/TESTER_FEEDBACK.md](docs/TESTER_FEEDBACK.md).

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
