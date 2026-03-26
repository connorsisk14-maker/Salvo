create table if not exists public.salvo_workspace_tool_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.salvo_workspaces(id) on delete cascade,
  policy_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists salvo_workspace_tool_policies_workspace_id_key
  on public.salvo_workspace_tool_policies (workspace_id);
