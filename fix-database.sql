-- =============================================================
-- ClassTrans — consolidated database fix
-- =============================================================
-- HOW TO RUN: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- This script is IDEMPOTENT: it is safe to run more than once.
--
-- It fixes:
--   • #1 / #2  AI translation, polishing and minutes — restores REAL DashScope
--              model names (earlier tooling stored non-existent names such as
--              'qwen3.6-35b-a3b' and 'deepseek-v4-flash', which DashScope
--              rejects).
--   • #4       Saved transcripts disappearing after refresh — restores the
--              table GRANTs + RLS policies. Without the base GRANT, every query
--              fails with "permission denied for table … (42501)", so sessions
--              and transcripts were never actually written to the cloud.
--
-- This supersedes fix-global-settings.sql (which wrote the bad model names).
-- =============================================================

-- -------------------------------------------------------------
-- 1) Restore real, working DashScope model names
-- -------------------------------------------------------------
INSERT INTO public.global_settings (key, value, updated_at) VALUES
  ('ai_model_name',       'qwen-plus',              now()),
  ('realtime_model_name', 'qwen-turbo',             now()),
  ('summary_model_name',  'qwen-plus',              now()),
  ('asr_model_name',      'paraformer-realtime-v2', now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();

-- -------------------------------------------------------------
-- 2) Enable RLS + grant table privileges to the API roles
--    (PostgREST uses role `authenticated` for logged-in users; RLS then
--     filters rows. The base GRANT must exist or every query is denied.)
-- -------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  -- Enable RLS on every table that exists.
  FOREACH t IN ARRAY ARRAY[
    'profiles','user_settings','glossary_terms',
    'sessions','transcripts','usage_logs','global_settings'
  ] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;

  -- Per-user data tables: full CRUD for authenticated users (RLS scopes rows).
  FOREACH t IN ARRAY ARRAY[
    'profiles','user_settings','glossary_terms',
    'sessions','transcripts','usage_logs'
  ] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    END IF;
  END LOOP;

  -- global_settings: world-readable model config; only admins may write.
  IF to_regclass('public.global_settings') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON public.global_settings TO anon, authenticated';
    EXECUTE 'GRANT INSERT, UPDATE ON public.global_settings TO authenticated';
  END IF;
END $$;

-- -------------------------------------------------------------
-- 3) RLS policies (drop + recreate, guarded by table existence)
-- -------------------------------------------------------------
DO $$
BEGIN
  -- profiles (owner = row id)
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users_own_profile" ON public.profiles;
    CREATE POLICY "users_own_profile" ON public.profiles
      FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
  END IF;

  -- user_settings (owner = user_id)
  IF to_regclass('public.user_settings') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users_own_settings" ON public.user_settings;
    DROP POLICY IF EXISTS "users_can_select_own_settings" ON public.user_settings;
    DROP POLICY IF EXISTS "users_can_insert_own_settings" ON public.user_settings;
    DROP POLICY IF EXISTS "users_can_update_own_settings" ON public.user_settings;
    DROP POLICY IF EXISTS "users_can_delete_own_settings" ON public.user_settings;
    CREATE POLICY "users_own_settings" ON public.user_settings
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  -- glossary_terms (owner = user_id)
  IF to_regclass('public.glossary_terms') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users_own_glossary" ON public.glossary_terms;
    CREATE POLICY "users_own_glossary" ON public.glossary_terms
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  -- sessions (owner = user_id)
  IF to_regclass('public.sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users_own_sessions" ON public.sessions;
    DROP POLICY IF EXISTS "users_can_select_own_sessions" ON public.sessions;
    DROP POLICY IF EXISTS "users_can_insert_own_sessions" ON public.sessions;
    DROP POLICY IF EXISTS "users_can_update_own_sessions" ON public.sessions;
    DROP POLICY IF EXISTS "users_can_delete_own_sessions" ON public.sessions;
    CREATE POLICY "users_own_sessions" ON public.sessions
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  -- transcripts (owned transitively through their session)
  IF to_regclass('public.transcripts') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users_own_transcripts" ON public.transcripts;
    CREATE POLICY "users_own_transcripts" ON public.transcripts
      FOR ALL
      USING (session_id IN (SELECT id FROM public.sessions WHERE user_id = auth.uid()))
      WITH CHECK (session_id IN (SELECT id FROM public.sessions WHERE user_id = auth.uid()));
  END IF;

  -- usage_logs (owner = user_id)
  IF to_regclass('public.usage_logs') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users_own_usage" ON public.usage_logs;
    CREATE POLICY "users_own_usage" ON public.usage_logs
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  -- global_settings (public read, admin write)
  IF to_regclass('public.global_settings') IS NOT NULL THEN
    DROP POLICY IF EXISTS "anyone_can_read_global_settings" ON public.global_settings;
    DROP POLICY IF EXISTS "admins_can_update_global_settings" ON public.global_settings;
    DROP POLICY IF EXISTS "admins_can_insert_global_settings" ON public.global_settings;
    CREATE POLICY "anyone_can_read_global_settings" ON public.global_settings
      FOR SELECT USING (true);
    CREATE POLICY "admins_can_insert_global_settings" ON public.global_settings
      FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
      );
    CREATE POLICY "admins_can_update_global_settings" ON public.global_settings
      FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
      );
  END IF;
END $$;

-- -------------------------------------------------------------
-- 4) Verify (should list the four correct model names)
-- -------------------------------------------------------------
SELECT key, value FROM public.global_settings ORDER BY key;
