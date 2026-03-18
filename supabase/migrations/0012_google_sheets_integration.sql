alter table public.salvo_integration_configs
  drop constraint if exists salvo_integration_configs_integration_key_check;

alter table public.salvo_integration_configs
  add constraint salvo_integration_configs_integration_key_check
    check (
      integration_key in (
        'supabase',
        'claude_local',
        'llm_api',
        'process',
        'http',
        'google_sheets'
      )
    );
