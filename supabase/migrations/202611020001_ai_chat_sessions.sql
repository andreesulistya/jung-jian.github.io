-- AI Calorie Assistant: private, bounded chat memory.
create table if not exists public.ai_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Percakapan baru',
  memory_summary text not null default '',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_chat_messages_array check (jsonb_typeof(messages) = 'array'),
  constraint ai_chat_messages_limit check (jsonb_array_length(messages) <= 12)
);
create index if not exists ai_chat_sessions_user_updated_idx
  on public.ai_chat_sessions(user_id, updated_at desc);
alter table public.ai_chat_sessions enable row level security;
drop policy if exists "Users manage own AI chat sessions" on public.ai_chat_sessions;
create policy "Users manage own AI chat sessions"
  on public.ai_chat_sessions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
