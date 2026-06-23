-- =============================================================
-- Fix Supabase RLS Policies for user_settings and sessions
-- =============================================================
-- Run this in your Supabase SQL Editor
-- =============================================================

-- 1. Drop existing policies if they exist
DROP POLICY IF EXISTS "users_own_settings" ON user_settings;
DROP POLICY IF EXISTS "users_own_sessions" ON sessions;

-- 2. Recreate policies with proper permissions
-- User settings: users can SELECT, INSERT, UPDATE, DELETE their own settings
CREATE POLICY "users_can_select_own_settings" 
  ON user_settings FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "users_can_insert_own_settings" 
  ON user_settings FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_can_update_own_settings" 
  ON user_settings FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "users_can_delete_own_settings" 
  ON user_settings FOR DELETE 
  USING (auth.uid() = user_id);

-- Sessions: users can SELECT, INSERT, UPDATE, DELETE their own sessions
CREATE POLICY "users_can_select_own_sessions" 
  ON sessions FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "users_can_insert_own_sessions" 
  ON sessions FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_can_update_own_sessions" 
  ON sessions FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "users_can_delete_own_sessions" 
  ON sessions FOR DELETE 
  USING (auth.uid() = user_id);

-- 3. Verify RLS is enabled
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- 4. Check if user has a profile and settings record
-- If not, create them (run this for your user_id)
-- Replace 'cd92639b-74f8-419f-b365-ecdcdb00f89c' with your actual user_id from the error log

DO $$
DECLARE
  target_user_id UUID := 'cd92639b-74f8-419f-b365-ecdcdb00f89c';
BEGIN
  -- Create profile if missing
  INSERT INTO profiles (id, display_name)
  VALUES (target_user_id, 'Admin User')
  ON CONFLICT (id) DO NOTHING;
  
  -- Create user_settings if missing
  INSERT INTO user_settings (user_id)
  VALUES (target_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END $$;

-- Made with Bob
