create table if not exists public.salvo_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.salvo_workspaces(id),
  lead_key text not null,
  row_context jsonb not null default '{}'::jsonb,
  source_scraper_run_id uuid references public.salvo_runs(id),
  source_strategist_task_id uuid references public.salvo_tasks(id),
  source_strategist_run_id uuid references public.salvo_runs(id),
  scraped_at timestamptz not null default now(),
  qualified_at timestamptz,
  contacted_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, lead_key),
  unique (source_scraper_run_id),
  unique (source_strategist_task_id),
  unique (source_strategist_run_id)
);

create index if not exists idx_salvo_leads_workspace_scraped_at
  on public.salvo_leads (workspace_id, scraped_at desc);

create index if not exists idx_salvo_leads_workspace_qualified_at
  on public.salvo_leads (workspace_id, qualified_at desc);

drop trigger if exists trg_salvo_leads_touch_updated_at on public.salvo_leads;
create trigger trg_salvo_leads_touch_updated_at
before update on public.salvo_leads
for each row execute function public.salvo_touch_updated_at();
