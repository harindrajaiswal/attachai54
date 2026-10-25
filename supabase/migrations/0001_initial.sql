-- Orbit AI Supabase persistence schema. Apply with the Supabase CLI.
create extension if not exists pgcrypto;
create extension if not exists vector;

-- The application bucket is private; objects are always written below <tenant-id>/.
insert into storage.buckets (id, name, public)
values ('knowledge', 'knowledge', false)
on conflict (id) do update set public = false;

create table if not exists clients (
  id uuid primary key, name text not null, slug text not null unique,
  enabled boolean not null default true, config jsonb not null default '{}'::jsonb,
  prompt text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(), client_id uuid not null unique references clients(id) on delete cascade,
  key_hash text not null unique, enabled boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists domains (
  client_id uuid not null references clients(id) on delete cascade, domain text not null,
  primary key (client_id, domain)
);
create table if not exists prompt_versions (
  id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id) on delete cascade,
  prompt text not null, created_at timestamptz not null default now()
);
create table if not exists conversations (
  id uuid primary key, client_id uuid not null references clients(id) on delete cascade,
  session_id uuid not null, created_at timestamptz not null default now(), unique(client_id, session_id)
);
create table if not exists messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')), content text not null, created_at timestamptz not null default now()
);
create table if not exists leads (
  id uuid primary key, client_id uuid not null references clients(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null, data jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new','contacted','qualified','won','lost')),
  created_at timestamptz not null default now()
);
create table if not exists lead_workflow (
  lead_id uuid primary key references leads(id) on delete cascade, status text not null default 'new',
  assignee text, notes text not null default '', updated_at timestamptz not null default now()
);
create table if not exists usage_logs (
  id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id) on delete cascade,
  kind text not null, units bigint not null, latency_ms double precision not null, created_at timestamptz not null default now()
);
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(), client_id uuid references clients(id) on delete set null,
  action text not null, detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists knowledge_files (
  client_id uuid not null references clients(id) on delete cascade, filename text not null,
  size bigint not null, chunks integer not null, status text not null, updated_at timestamptz not null default now(),
  primary key(client_id, filename)
);
create table if not exists settings (
  key text primary key, value jsonb not null, updated_at timestamptz not null default now()
);
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(), client_id uuid references clients(id) on delete cascade,
  recipient text, subject text not null, payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempts integer not null default 0, last_error text, created_at timestamptz not null default now(), processed_at timestamptz
);
-- Compatibility alias for systems that call this an outbox. PostgreSQL does
-- not support CREATE VIEW IF NOT EXISTS, so guard it explicitly.
do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'outbox' and n.nspname = 'public'
  ) then
    execute 'create view public.outbox as select * from public.notifications';
  end if;
end $$;
create table if not exists knowledge_vectors (
  id uuid primary key, client_id uuid not null references clients(id) on delete cascade,
  source text not null, content text not null, embedding vector(128) not null, created_at timestamptz not null default now()
);

create index if not exists domains_domain_idx on domains(domain);
create index if not exists conversations_client_created_idx on conversations(client_id, created_at desc);
create index if not exists messages_conversation_created_idx on messages(conversation_id, created_at);
create index if not exists leads_client_created_idx on leads(client_id, created_at desc);
create index if not exists usage_client_created_idx on usage_logs(client_id, created_at desc);
create index if not exists audit_client_created_idx on audit_logs(client_id, created_at desc);
create index if not exists notifications_pending_idx on notifications(status, created_at) where status = 'pending';
create index if not exists knowledge_vectors_client_source_idx on knowledge_vectors(client_id, source);
create index if not exists knowledge_vectors_embedding_idx on knowledge_vectors using hnsw (embedding vector_cosine_ops);

create or replace function match_knowledge_vectors(query_embedding vector(128), match_client_id uuid, match_threshold float, match_count int)
returns table (id uuid, text text, source text, similarity float) language sql stable security invoker set search_path = public as $$
  select kv.id, kv.content, kv.source, 1 - (kv.embedding <=> query_embedding) as similarity
  from knowledge_vectors kv where kv.client_id = match_client_id
    and 1 - (kv.embedding <=> query_embedding) >= match_threshold
  order by kv.embedding <=> query_embedding limit match_count;
$$;

-- RLS is enabled even though the backend normally uses the service role. The
-- tenant claim is intentionally required for direct client-side access.
create or replace function app_tenant_id() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')::uuid;
$$;

alter table clients enable row level security; alter table api_keys enable row level security;
alter table domains enable row level security; alter table prompt_versions enable row level security;
alter table conversations enable row level security; alter table messages enable row level security;
alter table leads enable row level security; alter table lead_workflow enable row level security;
alter table usage_logs enable row level security; alter table audit_logs enable row level security;
alter table knowledge_files enable row level security; alter table notifications enable row level security;
alter table knowledge_vectors enable row level security; alter table settings enable row level security;

-- Service role bypasses RLS. Authenticated requests are limited to their own tenant.
do $$
begin
  -- Policies have no CREATE ... IF NOT EXISTS form; guard each by name/table.
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'clients_tenant') then
    execute $policy$create policy clients_tenant on clients for all using (id = app_tenant_id()) with check (id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'api_keys_tenant') then
    execute $policy$create policy api_keys_tenant on api_keys for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'domains_tenant') then
    execute $policy$create policy domains_tenant on domains for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'prompts_tenant') then
    execute $policy$create policy prompts_tenant on prompt_versions for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'conversations_tenant') then
    execute $policy$create policy conversations_tenant on conversations for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'messages_tenant') then
    execute $policy$create policy messages_tenant on messages for all using (exists (select 1 from conversations c where c.id = conversation_id and c.client_id = app_tenant_id())) with check (exists (select 1 from conversations c where c.id = conversation_id and c.client_id = app_tenant_id()));$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'leads_tenant') then
    execute $policy$create policy leads_tenant on leads for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'workflow_tenant') then
    execute $policy$create policy workflow_tenant on lead_workflow for all using (exists (select 1 from leads l where l.id = lead_id and l.client_id = app_tenant_id())) with check (exists (select 1 from leads l where l.id = lead_id and l.client_id = app_tenant_id()));$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'usage_tenant') then
    execute $policy$create policy usage_tenant on usage_logs for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'audit_tenant') then
    execute $policy$create policy audit_tenant on audit_logs for all using (client_id = app_tenant_id() or client_id is null) with check (client_id = app_tenant_id() or client_id is null);$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'knowledge_tenant') then
    execute $policy$create policy knowledge_tenant on knowledge_files for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'notifications_tenant') then
    execute $policy$create policy notifications_tenant on notifications for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'vectors_tenant') then
    execute $policy$create policy vectors_tenant on knowledge_vectors for all using (client_id = app_tenant_id()) with check (client_id = app_tenant_id());$policy$;
  end if;
end $$;
