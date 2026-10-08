create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.monitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  address text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  threshold_percent integer not null default 8 check (threshold_percent between 2 and 30),
  enabled boolean not null default true,
  last_gap_percent double precision,
  last_coin text,
  last_checked_at timestamptz,
  last_error text,
  in_warning boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monitor_events (
  id bigint generated always as identity primary key,
  monitor_id uuid references public.monitors(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('warning', 'recovery')),
  message text not null check (char_length(message) <= 500),
  coin text,
  gap_percent double precision,
  created_at timestamptz not null default now()
);

create index if not exists monitor_events_user_time_idx on public.monitor_events(user_id, created_at desc);

alter table public.monitors enable row level security;
alter table public.monitor_events enable row level security;

revoke all on public.monitors from anon, authenticated;
revoke all on public.monitor_events from anon, authenticated;
grant select, delete on public.monitors to authenticated;
grant select, delete on public.monitor_events to authenticated;

create policy monitor_select_own on public.monitors for select to authenticated
  using (auth.uid() is not null and auth.uid() = user_id);
create policy monitor_delete_own on public.monitors for delete to authenticated
  using (auth.uid() is not null and auth.uid() = user_id);
create policy monitor_events_select_own on public.monitor_events for select to authenticated
  using (auth.uid() is not null and auth.uid() = user_id);
create policy monitor_events_delete_own on public.monitor_events for delete to authenticated
  using (auth.uid() is not null and auth.uid() = user_id);

create or replace function public.save_my_monitor(
  p_address text,
  p_threshold_percent integer
) returns public.monitors
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.monitors;
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Sign in is required'; end if;
  if p_address !~ '^0x[0-9a-fA-F]{40}$' then raise exception 'Enter a valid public account address'; end if;
  if p_threshold_percent < 2 or p_threshold_percent > 30 then raise exception 'Threshold must be between 2 and 30'; end if;
  insert into public.monitors(user_id, address, threshold_percent, enabled, last_error, updated_at)
  values (caller, lower(p_address), p_threshold_percent, true, null, now())
  on conflict (user_id) do update set
    address = excluded.address,
    threshold_percent = excluded.threshold_percent,
    enabled = true,
    last_error = null,
    updated_at = now()
  returning * into saved;
  return saved;
end;
$$;

revoke all on function public.save_my_monitor(text, integer) from public, anon;
grant execute on function public.save_my_monitor(text, integer) to authenticated;

create or replace function public.record_monitor_result(
  p_monitor_id uuid,
  p_gap_percent double precision,
  p_coin text,
  p_checked_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_monitor public.monitors;
  is_warning boolean;
  is_recovery boolean;
  resulting_warning boolean;
  created_event bigint;
  event_message text;
  event_kind text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service access is required'; end if;
  select * into current_monitor from public.monitors where id = p_monitor_id for update;
  if not found then return jsonb_build_object('changed', false); end if;

  is_warning := p_gap_percent is not null and p_gap_percent <= current_monitor.threshold_percent;
  is_recovery := p_gap_percent is not null and current_monitor.in_warning
    and p_gap_percent > current_monitor.threshold_percent + 2;
  resulting_warning := case
    when is_warning then true
    when is_recovery then false
    else current_monitor.in_warning
  end;

  if is_warning and not current_monitor.in_warning then
    event_kind := 'warning';
    event_message := p_coin || ' is ' || round(p_gap_percent::numeric, 2)::text
      || ' percent from its reported liquidation price. Your alert threshold is '
      || current_monitor.threshold_percent::text || ' percent.';
  elsif is_recovery then
    event_kind := 'recovery';
    event_message := 'The nearest reported liquidation price is now '
      || round(p_gap_percent::numeric, 2)::text || ' percent away.';
  end if;

  update public.monitors set
    last_gap_percent = p_gap_percent,
    last_coin = p_coin,
    last_checked_at = p_checked_at,
    last_error = null,
    in_warning = resulting_warning,
    updated_at = now()
  where id = current_monitor.id;

  if event_kind is not null then
    insert into public.monitor_events(monitor_id, user_id, kind, message, coin, gap_percent)
    values (
      current_monitor.id,
      current_monitor.user_id,
      event_kind,
      event_message,
      p_coin,
      p_gap_percent
    ) returning id into created_event;
  end if;

  return jsonb_build_object('changed', event_kind is not null, 'kind', event_kind, 'event_id', created_event);
end;
$$;

revoke all on function public.record_monitor_result(uuid, double precision, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_monitor_result(uuid, double precision, text, timestamptz) to service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.monitor_job_lock (
  id boolean primary key default true check (id),
  lease_until timestamptz not null default '-infinity'
);
insert into private.monitor_job_lock(id) values (true) on conflict (id) do nothing;
revoke all on private.monitor_job_lock from public, anon, authenticated;

create or replace function public.claim_monitor_job()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  update private.monitor_job_lock
  set lease_until = now() + interval '4 minutes'
  where id = true and lease_until < now();
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.release_monitor_job()
returns void
language sql
security definer
set search_path = ''
as $$
  update private.monitor_job_lock set lease_until = '-infinity' where id = true;
$$;

revoke all on function public.claim_monitor_job() from public, anon, authenticated;
revoke all on function public.release_monitor_job() from public, anon, authenticated;
grant execute on function public.claim_monitor_job() to service_role;
grant execute on function public.release_monitor_job() to service_role;
