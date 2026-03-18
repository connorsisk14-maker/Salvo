create table if not exists public.salvo_agent_trust_tiers (
  workspace_id uuid not null references public.salvo_workspaces(id) on delete cascade,
  agent_profile text not null check (agent_profile in ('builder', 'researcher', 'debugger', 'documenter', 'content', 'lead_scraper', 'lead_strategist', 'ops')),
  trust_tier text not null check (trust_tier in ('unrestricted', 'standard', 'restricted', 'probation', 'scraper')),
  successful_runs integer not null default 0 check (successful_runs >= 0),
  last_run_at timestamptz,
  promoted_at timestamptz,
  managed_by text not null default 'system' check (managed_by in ('system', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, agent_profile)
);

drop trigger if exists trg_salvo_agent_trust_tiers_touch_updated_at on public.salvo_agent_trust_tiers;
create trigger trg_salvo_agent_trust_tiers_touch_updated_at
before update on public.salvo_agent_trust_tiers
for each row execute function public.salvo_touch_updated_at();
