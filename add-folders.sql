-- =============================================================
-- ClassTrans — Folders feature migration
-- =============================================================
-- HOW TO RUN: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Idempotent: safe to run more than once.
--
-- Adds cloud folders so recordings can be organized:
--   • public.folders            — a user's custom folders (name + color)
--   • public.sessions.folder_id — which folder a session belongs to
--                                 (NULL = 未归档 / Unfiled)
-- =============================================================

-- 1) folders table
CREATE TABLE IF NOT EXISTS public.folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT 'indigo',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2) sessions.folder_id (deleting a folder leaves its sessions as 未归档)
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES public.folders(id) ON DELETE SET NULL;

-- 3) indexes
CREATE INDEX IF NOT EXISTS idx_folders_user ON public.folders(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_folder ON public.sessions(folder_id);

-- 4) RLS + grants (PostgREST role `authenticated`; RLS scopes rows per user)
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folders TO authenticated;

DROP POLICY IF EXISTS "users_own_folders" ON public.folders;
CREATE POLICY "users_own_folders" ON public.folders
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 5) verify
SELECT 'folders' AS table, count(*) FROM public.folders;
