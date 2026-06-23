-- =============================================================
-- Fix Global Settings - Ensure all models are set to correct values
-- =============================================================
-- Run this in Supabase SQL Editor to fix the global settings
-- =============================================================

-- Update all global settings to correct values
INSERT INTO public.global_settings (key, value, updated_at) VALUES
  ('ai_model_name', 'qwen3.6-35b-a3b', now()),
  ('realtime_model_name', 'deepseek-v4-flash', now()),
  ('summary_model_name', 'qwen3.6-35b-a3b', now()),
  ('asr_model_name', 'paraformer-realtime-v2', now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();

-- Verify the settings
SELECT * FROM public.global_settings ORDER BY key;

-- Made with Bob
