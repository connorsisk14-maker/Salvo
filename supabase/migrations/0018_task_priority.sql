alter table public.salvo_tasks
  add column if not exists priority text default 'medium';

alter table public.salvo_tasks
  drop constraint if exists salvo_tasks_priority_check;
alter table public.salvo_tasks
  add constraint salvo_tasks_priority_check
  check (priority in ('urgent','high','medium','low'));

update public.salvo_tasks
  set priority = 'medium'
  where priority is null;

alter table public.salvo_tasks
  alter column priority set not null;

drop index if exists idx_salvo_tasks_claim;
create index if not exists idx_salvo_tasks_claim
  on public.salvo_tasks (
    status,
    requires_approval,
    approved_at,
    (
      case priority
        when 'urgent' then 1
        when 'high' then 2
        when 'medium' then 3
        when 'low' then 4
        else 5
      end
    ),
    created_at
  )
  where status = 'queued';
