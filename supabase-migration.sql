-- =============================================================
-- ClassTrans Pro – Supabase Database Migration
-- =============================================================
-- Run this in the Supabase SQL editor or via the CLI:
--   supabase db push
-- =============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User profiles
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- User settings
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  theme TEXT DEFAULT 'dark',
  preferred_mic_device TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Custom glossary terms
CREATE TABLE glossary_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_text TEXT NOT NULL,
  to_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, from_text)
);

-- Saved sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  summary TEXT,
  duration_sec INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  mode TEXT DEFAULT 'mic',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Session transcripts (individual bubbles)
CREATE TABLE transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker TEXT,
  en_text TEXT,
  zh_text TEXT,
  is_polished BOOLEAN DEFAULT false,
  confidence REAL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI usage logs
CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model TEXT,
  purpose TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX idx_glossary_user ON glossary_terms(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_created ON sessions(user_id, created_at DESC);
CREATE INDEX idx_transcripts_session ON transcripts(session_id, sort_order);
CREATE INDEX idx_usage_user_time ON usage_logs(user_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE glossary_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies - each user can only access their own data
CREATE POLICY "users_own_profile" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "users_own_settings" ON user_settings FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_glossary" ON glossary_terms FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_sessions" ON sessions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "users_own_transcripts" ON transcripts FOR ALL USING (
  session_id IN (SELECT id FROM sessions WHERE user_id = auth.uid())
);
CREATE POLICY "users_own_usage" ON usage_logs FOR ALL USING (auth.uid() = user_id);

-- Auto-create profile + settings on new user registration
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  INSERT INTO user_settings (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
