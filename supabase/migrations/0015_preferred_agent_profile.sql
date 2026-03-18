alter table public.salvo_tasks
  add column if not exists preferred_agent_profile text check (
    preferred_agent_profile in (
      'builder',
      'researcher',
      'debugger',
      'documenter',
      'content',
      'lead_scraper',
      'lead_strategist',
      'ops'
    )
  );
