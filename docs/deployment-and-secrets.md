# Deploy Hydromancer

Anyone can use the deployed monitor. Supabase creates a private anonymous session for each visitor, saves each visitor's monitor and event history separately, and runs scheduled checks. No email service, wallet secret, or Hyperliquid API key is needed.

## 1. Create Supabase and Cloudflare Turnstile projects

Create a Supabase project at https://supabase.com/dashboard. Keep its database password in a password manager. In **Project Settings → API**, copy the project URL and publishable key.

Create a Cloudflare Turnstile widget for both your deployed domain and `localhost`. Keep its site key and secret key. The site key is public; the secret key belongs only in Supabase Auth settings.

Create `.env.local` in this project directory with these values. Do not commit it:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
VITE_TURNSTILE_SITE_KEY=YOUR_TURNSTILE_SITE_KEY
```

## 2. Enable anonymous sessions and CAPTCHA

In Supabase **Authentication → Sign In / Providers**, enable anonymous sign ins. Then go to **Authentication → Bot and Abuse Protection**, enable CAPTCHA, select Cloudflare Turnstile, and enter the Turnstile secret key. Keep the Vercel site key and Supabase secret paired with the same Turnstile widget.

Hydromancer sends the verified challenge token with each anonymous sign in. Supabase assigns a separate user ID to each visitor, so row level security can keep monitor addresses and alert history private. The session is stored in that browser; clearing browser storage or changing devices means the visitor cannot recover the session. Supabase recommends CAPTCHA for anonymous sign ins because anonymous users consume project auth records.

## 3. Apply the database migration

Install the Supabase CLI, sign in, link this folder to your project, and apply the migration:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

The migration creates per user monitor and event tables, row level security, a narrow monitor save function, atomic warning and recovery transitions, and a scheduler lease. The browser cannot write monitor risk state or create events.

## 4. Deploy the scheduled monitor

Generate a random secret with at least 64 characters using a password manager. Store it as a Supabase Edge Function secret:

```powershell
npx supabase secrets set MONITOR_CRON_SECRET=YOUR_RANDOM_SECRET
npx supabase functions deploy monitor --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

The function requires the secret in an `x-monitor-secret` header and uses Supabase's server supplied service role key internally. Never expose either secret to the browser.

In Supabase SQL Editor, run `supabase/setup-cron.sql` after replacing its three placeholders with the project URL, publishable or anon key, and the same random secret. The script stores them in Supabase Vault and schedules a check each minute. Do not commit an edited copy containing actual credentials.

## 5. Deploy the public app

Deploy the GitHub repository to Vercel as a Vite project. Add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_TURNSTILE_SITE_KEY` as Production environment values, then redeploy. Set the deployed domain in the Turnstile widget and the Supabase Auth URL configuration.

## 6. Run the judge flow

1. Open the public landing page and choose **Monitor an account**.
2. Choose **Continue privately** and complete the security check.
3. Enter a real public Hyperliquid address that you are permitted to inspect.
4. Confirm its actual positions and current market data load and that the freshness indicators update.
5. Change the alert threshold and inspect settings and activity.
6. Confirm **Server checked** updates within two minutes.
7. Open a private browser window, create a second session, and verify it cannot see the first session's saved address or event history.
8. Return to the original browser and confirm its session and monitor survive a reload.

Do not stage or replay values as live market data. Until the deployed flow has passed these steps, describe the app as a preview.

## Required values

| Value | Storage | Use |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local` and Vercel | Browser Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `.env.local` and Vercel | Public Supabase key, constrained by row level security |
| `VITE_TURNSTILE_SITE_KEY` | `.env.local` and Vercel | Displays visitor anti bot check |
| Turnstile secret key | Supabase Auth CAPTCHA settings | Validates the anti bot check |
| `MONITOR_CRON_SECRET` | Supabase Function secrets and Supabase Vault | Protects the scheduled monitor call |
| `SUPABASE_URL` | Automatically available to the Edge Function | Function project connection |
| `SUPABASE_SERVICE_ROLE_KEY` | Automatically available to the Edge Function | Private server database access |

There is no trading integration, user email requirement, alert email service, private key, seed phrase, or Hyperliquid secret.
