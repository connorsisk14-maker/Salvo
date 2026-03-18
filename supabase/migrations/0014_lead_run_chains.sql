create table if not exists public.salvo_lead_run_chains (
  id uuid primary key default gen_random_uuid(),
  scraper_run_id uuid not null references public.salvo_runs(id),
  strategist_task_id uuid not null references public.salvo_tasks(id),
  strategist_run_id uuid references public.salvo_runs(id),
  row_context jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scraper_run_id),
  unique (strategist_task_id)
);

drop trigger if exists trg_salvo_lead_run_chains_touch_updated_at on public.salvo_lead_run_chains;
create trigger trg_salvo_lead_run_chains_touch_updated_at
before update on public.salvo_lead_run_chains
for each row execute function public.salvo_touch_updated_at();
