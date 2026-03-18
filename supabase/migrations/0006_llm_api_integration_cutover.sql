do $$
declare
  constraint_name text;
begin
  select c.conname
    into constraint_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'salvo_integration_configs'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%integration_key%';

  if constraint_name is not null then
    execute format(
      'alter table public.salvo_integration_configs drop constraint %I',
      constraint_name
    );
  end if;
end
$$;

alter table public.salvo_integration_configs
  add constraint salvo_integration_configs_integration_key_check
  check (integration_key in ('supabase','llm_api','claude_local','process','http'));

with claude as (
  select config_json
  from public.salvo_integration_configs
  where integration_key = 'claude_local'
  limit 1
),
llm as (
  select config_json
  from public.salvo_integration_configs
  where integration_key = 'llm_api'
  limit 1
),
merged as (
  select jsonb_strip_nulls(
    jsonb_build_object(
      'provider',
      coalesce(
        (select config_json->'provider' from llm),
        (select config_json->'provider' from claude),
        to_jsonb('anthropic'::text)
      ),
      'apiKey',
      coalesce(
        (select config_json->'apiKey' from llm),
        (select config_json->'authToken' from llm),
        (select config_json->'apiKey' from claude),
        (select config_json->'authToken' from claude)
      ),
      'baseUrl',
      coalesce(
        (select config_json->'baseUrl' from llm),
        (select config_json->'baseUrl' from claude)
      ),
      'defaultModel',
      coalesce(
        (select config_json->'defaultModel' from llm),
        (select config_json->'defaultModel' from claude)
      )
    )
  ) as config_json
)
insert into public.salvo_integration_configs (integration_key, config_json)
select 'llm_api', config_json
from merged
where exists (select 1 from claude)
   or exists (select 1 from llm)
on conflict (integration_key)
do update set config_json = excluded.config_json;

delete from public.salvo_integration_configs
where integration_key = 'claude_local';

alter table public.salvo_integration_configs
  drop constraint if exists salvo_integration_configs_integration_key_check;

alter table public.salvo_integration_configs
  add constraint salvo_integration_configs_integration_key_check
  check (integration_key in ('supabase','llm_api','process','http'));
