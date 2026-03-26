create table if not exists public.salvo_run_checkpoints (
  run_id uuid not null references public.salvo_runs(id) on delete cascade,
  checkpoint_key text not null,
  checkpoint_state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(run_id, checkpoint_key)
);

create index if not exists idx_salvo_run_checkpoints_run
  on public.salvo_run_checkpoints(run_id);
