import { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';

export function useGlobalSettings() {
  const [settings, setSettings] = useState({
    aiModelName: 'qwen3.5-122b-a10b',
    realtimeModelName: 'qwen-turbo',
    summaryModelName: 'qwen3.5-122b-a10b',
    asrModelName: 'paraformer-realtime-v2'
  });
  const [loading, setLoading] = useState(true);

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase.from('global_settings').select('*');
      if (error) throw error;
      
      if (data && data.length > 0) {
        const newSettings = { ...settings };
        data.forEach(item => {
          if (item.key === 'ai_model_name') newSettings.aiModelName = item.value;
          if (item.key === 'realtime_model_name') newSettings.realtimeModelName = item.value;
          if (item.key === 'summary_model_name') newSettings.summaryModelName = item.value;
          if (item.key === 'asr_model_name') newSettings.asrModelName = item.value;
        });
        setSettings(newSettings);
      }
    } catch (err) {
      console.error('Failed to fetch global settings:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();

    // Subscribe to changes in the global_settings table
    const channel = supabase.channel('global_settings_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'global_settings' },
        (payload) => {
          fetchSettings();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = async (newValues) => {
    try {
      const updates = [];
      if (newValues.aiModelName) updates.push({ key: 'ai_model_name', value: newValues.aiModelName });
      if (newValues.realtimeModelName) updates.push({ key: 'realtime_model_name', value: newValues.realtimeModelName });
      if (newValues.summaryModelName) updates.push({ key: 'summary_model_name', value: newValues.summaryModelName });
      if (newValues.asrModelName) updates.push({ key: 'asr_model_name', value: newValues.asrModelName });

      if (updates.length > 0) {
        const { error } = await supabase.from('global_settings').upsert(updates);
        if (error) throw error;
        await fetchSettings();
        return true;
      }
    } catch (err) {
      console.error('Failed to update global settings:', err);
      throw err;
    }
  };

  return { settings, loading, updateSettings };
}
