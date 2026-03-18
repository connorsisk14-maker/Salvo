alter table public.salvo_runs
  add column if not exists cancellation_requested_at timestamptz;

create index if not exists idx_salvo_runs_cancellation_requested
  on public.salvo_runs (cancellation_requested_at)
  where cancellation_requested_at is not null;
