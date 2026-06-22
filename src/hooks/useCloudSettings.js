import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';

// Default settings used before cloud data loads
const DEFAULT_SETTINGS = {
  theme: 'dark',
  preferred_mic_device: '',
};

export function useCloudSettings(userId) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef(null);

  // Load settings on mount / user change
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!cancelled && data && !error) {
        setSettings({
          theme: data.theme || DEFAULT_SETTINGS.theme,
          preferred_mic_device: data.preferred_mic_device || DEFAULT_SETTINGS.preferred_mic_device,
        });
      }
      if (!cancelled) setLoaded(true);
    })();

    return () => { cancelled = true; };
  }, [userId]);

  // Update a setting (optimistic + debounced cloud write)
  const updateSetting = useCallback((key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));

    // Debounce cloud write to avoid excessive updates
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!userId) return;
      await supabase
        .from('user_settings')
        .update({ [key]: value, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    }, 500);
  }, [userId]);

  return { settings, loaded, updateSetting };
}
