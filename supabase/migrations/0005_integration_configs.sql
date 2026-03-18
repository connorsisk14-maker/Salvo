create table if not exists public.salvo_integration_configs (
  integration_key text primary key check (integration_key in ('supabase','claude_local','process','http')),
  config_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_salvo_integration_configs_updated
  on public.salvo_integration_configs (updated_at desc);

drop trigger if exists trg_salvo_integration_configs_touch_updated_at on public.salvo_integration_configs;
create trigger trg_salvo_integration_configs_touch_updated_at
before update on public.salvo_integration_configs
for each row execute function public.salvo_touch_updated_at();
