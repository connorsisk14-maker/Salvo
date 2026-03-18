create table if not exists public.salvo_task_dependencies (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.salvo_tasks(id) on delete cascade,
  dependency_contract_id uuid not null references public.salvo_contracts(id),
  reason text,
  created_at timestamptz not null default now()
);

alter table public.salvo_tasks
  add column if not exists dependency_block_reason text,
  add column if not exists dependency_blocked_at timestamptz;

create index if not exists idx_salvo_task_dependencies_task on public.salvo_task_dependencies(task_id);
create index if not exists idx_salvo_task_dependencies_contract on public.salvo_task_dependencies(dependency_contract_id);
