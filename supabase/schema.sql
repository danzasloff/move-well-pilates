-- Run this in Supabase SQL Editor.

create table if not exists public.app_states (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_integrations (
  id text primary key,
  square_token jsonb,
  updated_at timestamptz not null default now()
);

-- This app writes via server-side service role key.
-- Keep RLS on and lock down public access.
alter table public.app_states enable row level security;
alter table public.app_integrations enable row level security;

-- No public policies added intentionally.
