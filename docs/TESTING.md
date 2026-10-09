# Testing and verification

## Automated checks

Run these commands from the repository root with Node.js 20 or newer, npm, and Deno 2.9.7:

```powershell
npm ci
deno check supabase/functions/monitor/index.ts
npm.cmd run test
npm.cmd run build
```

On Unix-like shells, use `npm run test` and `npm run build`. `npm ci` installs the versions recorded in `package-lock.json`; the test command runs Vitest, and the build command runs TypeScript checking followed by the Vite production build.

### Verified in this working session

| Command | Result |
| --- | --- |
| `deno check supabase/functions/monitor/index.ts` | Passed with Deno 2.9.7. This checks Edge Function types and module resolution; it does not deploy or execute the function in Supabase Edge Runtime. |
| `npm.cmd run test` | Passed: 2 test files and 33 tests. |
| `npm.cmd run build` | Passed: `tsc --noEmit` and Vite production build. |

The GitHub Actions workflow at `.github/workflows/checks.yml` runs the Deno check, dependency install, tests, and build for pushes and pull requests. Creating the workflow does not mean a hosted Actions run has succeeded; check the repository's Actions tab after pushing to see its status.

## Automated test scope

Vitest covers liquidation distance for long and short positions, negative and zero distance, incomplete position data, invalid prices and sizes, mark quote freshness, warning and recovery transitions, malformed Hyperliquid snapshots, and mocked HTTP and WebSocket behavior. These tests do not call the live Hyperliquid API or a Supabase project.

The production build checks the frontend TypeScript project and bundles the Vite app. The Deno check validates the Edge Function's imports and types, but neither check deploys or exercises the function in a hosted Supabase Edge Runtime.

### Hosted service probes performed

Using the existing local public Supabase configuration, a read-only Auth settings request succeeded. A POST to the monitor endpoint with a deliberately invalid secret returned `401`, as expected from its authorization gate. This confirms that the configured endpoint responds and rejects an invalid secret; it does not confirm that the latest local function source is deployed or that a monitor job was run.

## Manual integration checks

For an integration run against configured services:

1. Start the app with `npm run dev` and confirm the landing and monitor screens load.
2. Enter a public Hyperliquid address that you are permitted to inspect. Confirm account positions and mark prices load, and that the shown distance corresponds to the reported liquidation price and live mark price.
3. Confirm stale account or mark data and any incomplete open position make the risk assessment unavailable and do not create a warning or recovery event.
4. With browser notifications enabled, observe a threshold crossing and recovery above the threshold plus the two percentage point buffer. Confirm local mode records each transition once.
5. In a separately configured Supabase project, verify anonymous sign-in and row-level isolation, deploy the monitor Edge Function, configure its secrets and Cron job, and confirm scheduled checks record transitions once. Confirm unavailable inputs do not change the warning state.

These checks require real browser permissions and, for hosted monitoring, a correctly configured Supabase project. They have not been represented as completed unless explicitly reported in the verification table above. A displayed risk distance is informational and is not a guarantee of liquidation timing.
