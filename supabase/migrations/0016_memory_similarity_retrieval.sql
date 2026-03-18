create extension if not exists pg_trgm;

create index if not exists idx_salvo_memories_semantic_lookup
  on public.salvo_memories
  using gin (
    lower(
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(body_markdown, '') || ' ' ||
      coalesce(contract_family_key, '')
    ) gin_trgm_ops
  );
