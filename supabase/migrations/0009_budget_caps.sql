create table if not exists public.salvo_budget_limits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.salvo_workspaces(id) on delete cascade,
  contract_family_key text,
  limit_usd numeric(12, 6) not null check (limit_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_salvo_budget_limits_workspace_scope
  on public.salvo_budget_limits (workspace_id)
  where contract_family_key is null;

create unique index if not exists idx_salvo_budget_limits_family_scope
  on public.salvo_budget_limits (workspace_id, contract_family_key)
  where contract_family_key is not null;

create index if not exists idx_salvo_budget_limits_workspace_lookup
  on public.salvo_budget_limits (workspace_id, contract_family_key);

drop trigger if exists trg_salvo_budget_limits_touch_updated_at on public.salvo_budget_limits;
create trigger trg_salvo_budget_limits_touch_updated_at
before update on public.salvo_budget_limits
for each row execute function public.salvo_touch_updated_at();
