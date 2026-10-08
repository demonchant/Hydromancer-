-- Run once in the Supabase SQL Editor after deploying the monitor function.
-- Replace each value with the matching value from your own Supabase project.
-- Keep the cron secret private. Never put it in a VITE variable or browser code.

select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co/functions/v1/monitor',
  'hydromancer_function_url'
);
select vault.create_secret('YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY', 'hydromancer_api_key');
select vault.create_secret('YOUR_RANDOM_64_CHARACTER_CRON_SECRET', 'hydromancer_cron_secret');

select cron.unschedule(jobid)
from cron.job
where jobname = 'hydromancer_monitor_each_minute';

select cron.schedule(
  'hydromancer_monitor_each_minute',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'hydromancer_function_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'hydromancer_api_key'),
        'x-monitor-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hydromancer_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $$
);
