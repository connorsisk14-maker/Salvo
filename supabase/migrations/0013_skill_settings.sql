create table if not exists public.salvo_skill_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.salvo_workspaces(id),
  skill_name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, skill_name)
);

drop trigger if exists trg_salvo_skill_settings_touch_updated_at on public.salvo_skill_settings;
create trigger trg_salvo_skill_settings_touch_updated_at
before update on public.salvo_skill_settings
for each row execute function public.salvo_touch_updated_at();
