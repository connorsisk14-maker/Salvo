create table if not exists public.salvo_daemon_heartbeats (
  daemon_type text primary key check (daemon_type in ('orchestrator', 'research')),
  daemon_id text not null,
  heartbeat_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_salvo_daemon_heartbeats_heartbeat
  on public.salvo_daemon_heartbeats (heartbeat_at desc);

drop trigger if exists trg_salvo_daemon_heartbeats_touch_updated_at on public.salvo_daemon_heartbeats;
create trigger trg_salvo_daemon_heartbeats_touch_updated_at
before update on public.salvo_daemon_heartbeats
for each row execute function public.salvo_touch_updated_at();
