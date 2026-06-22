-- =============================================================
-- Add Admin Panel & Global Settings
-- =============================================================

-- 1. Add is_admin column to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- 2. Create global_settings table
CREATE TABLE IF NOT EXISTS public.global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Insert default models
INSERT INTO public.global_settings (key, value) VALUES
  ('ai_model_name', 'qwen-plus'),
  ('realtime_model_name', 'qwen-turbo'),
  ('summary_model_name', 'qwen-plus'),
  ('asr_model_name', 'paraformer-realtime-v2')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now()
  WHERE public.global_settings.value = 'qwen3.5-122b-a10b';

-- 4. Enable RLS
ALTER TABLE public.global_settings ENABLE ROW LEVEL SECURITY;

-- 5. Create policies for global_settings
-- Everyone can read global settings
CREATE POLICY "anyone_can_read_global_settings"
  ON public.global_settings FOR SELECT
  USING (true);

-- Only admins can update global settings
CREATE POLICY "admins_can_update_global_settings"
  ON public.global_settings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

CREATE POLICY "admins_can_insert_global_settings"
  ON public.global_settings FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );
