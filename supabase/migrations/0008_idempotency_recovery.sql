create table if not exists public.salvo_idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null check (status in ('processing', 'completed')),
  response_status integer,
  response_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (scope, idempotency_key)
);

create index if not exists idx_salvo_idempotency_expires_at
  on public.salvo_idempotency_keys (expires_at);

drop trigger if exists trg_salvo_idempotency_touch_updated_at on public.salvo_idempotency_keys;
create trigger trg_salvo_idempotency_touch_updated_at
before update on public.salvo_idempotency_keys
for each row execute function public.salvo_touch_updated_at();
