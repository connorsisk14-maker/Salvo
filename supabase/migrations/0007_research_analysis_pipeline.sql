alter table public.salvo_memories
  add column if not exists contract_family_key text;

create table if not exists public.salvo_research_experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.salvo_workspaces(id),
  contract_family_key text not null,
  contract_category text not null,
  contract_subcategory text,
  sample_size integer not null check (sample_size > 0),
  source_digest text not null,
  source_run_ids uuid[] not null,
  metrics_json jsonb not null default '{}'::jsonb,
  body_markdown text not null,
  confidence numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  review_status text not null check (review_status in ('unreviewed','accepted','rejected')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.salvo_research_experiments
  add column if not exists source_digest text;

update public.salvo_research_experiments
set source_digest = md5(array_to_string(source_run_ids, '|'))
where source_digest is null or source_digest = '';

alter table public.salvo_research_experiments
  alter column source_digest set not null;

create table if not exists public.salvo_research_ingestions (
  run_id uuid primary key references public.salvo_runs(id),
  workspace_id uuid not null references public.salvo_workspaces(id),
  task_id uuid not null references public.salvo_tasks(id),
  contract_id uuid not null references public.salvo_contracts(id),
  contract_family_key text not null,
  contract_category text not null,
  contract_subcategory text,
  run_status text not null check (run_status in ('completed','failed')),
  evaluation_outcome text not null check (evaluation_outcome in ('passed','failed','hard_failed')),
  score integer not null,
  policy_denial_count integer not null default 0,
  event_count integer not null default 0,
  source_event_types text[] not null default '{}',
  source_json jsonb not null default '{}'::jsonb,
  experiment_id uuid references public.salvo_research_experiments(id),
  ingested_at timestamptz not null default now()
);

create table if not exists public.salvo_research_findings (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.salvo_research_experiments(id) on delete cascade,
  workspace_id uuid not null references public.salvo_workspaces(id),
  finding_type text not null,
  title text not null,
  body_markdown text not null,
  confidence numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  metadata_json jsonb not null default '{}'::jsonb,
  published_memory_id uuid references public.salvo_memories(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_salvo_research_ingestions_family_pending
  on public.salvo_research_ingestions (workspace_id, contract_family_key, ingested_at asc)
  where experiment_id is null;

create index if not exists idx_salvo_research_experiments_review
  on public.salvo_research_experiments (review_status, published_at, created_at desc);

create unique index if not exists uq_salvo_research_experiments_source_digest
  on public.salvo_research_experiments (workspace_id, contract_family_key, source_digest);

create index if not exists idx_salvo_memories_family_review
  on public.salvo_memories (workspace_id, contract_family_key, review_status, confidence desc, created_at desc);

drop trigger if exists trg_salvo_research_experiments_touch_updated_at on public.salvo_research_experiments;
create trigger trg_salvo_research_experiments_touch_updated_at
before update on public.salvo_research_experiments
for each row execute function public.salvo_touch_updated_at();

drop index if exists idx_salvo_runs_unsynthesized;
