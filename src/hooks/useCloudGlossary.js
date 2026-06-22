import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';

export function useCloudGlossary(userId) {
  const [terms, setTerms] = useState([]);
  const [loaded, setLoaded] = useState(false);

  // Load terms on mount / user change
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('glossary_terms')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      if (!cancelled && !error) {
        setTerms((data || []).map(t => ({ id: t.id, from: t.from_text, to: t.to_text })));
      }
      if (!cancelled) setLoaded(true);
    })();

    return () => { cancelled = true; };
  }, [userId]);

  const addTerm = useCallback(async (from, to) => {
    if (!userId || !from.trim() || !to.trim()) return null;

    // Optimistic update
    const tempId = crypto.randomUUID();
    const newTerm = { id: tempId, from: from.trim(), to: to.trim() };
    setTerms(prev => [...prev, newTerm]);

    const { data, error } = await supabase
      .from('glossary_terms')
      .upsert(
        { user_id: userId, from_text: from.trim(), to_text: to.trim() },
        { onConflict: 'user_id,from_text' }
      )
      .select()
      .single();

    if (error) {
      // Rollback
      setTerms(prev => prev.filter(t => t.id !== tempId));
      console.error('Failed to add glossary term:', error);
      return null;
    }

    // Replace temp with real record
    setTerms(prev => prev.map(t => t.id === tempId ? { id: data.id, from: data.from_text, to: data.to_text } : t));
    return data;
  }, [userId]);

  const removeTerm = useCallback(async (termId) => {
    // Optimistic removal
    setTerms(prev => prev.filter(t => t.id !== termId));

    const { error } = await supabase
      .from('glossary_terms')
      .delete()
      .eq('id', termId);

    if (error) {
      console.error('Failed to remove glossary term:', error);
      // Reload to restore state
      const { data } = await supabase
        .from('glossary_terms')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      setTerms((data || []).map(t => ({ id: t.id, from: t.from_text, to: t.to_text })));
    }
  }, [userId]);

  const updateTerm = useCallback(async (termId, from, to) => {
    // Optimistic update
    setTerms(prev => prev.map(t => t.id === termId ? { ...t, from, to } : t));

    const { error } = await supabase
      .from('glossary_terms')
      .update({ from_text: from, to_text: to })
      .eq('id', termId);

    if (error) {
      console.error('Failed to update glossary term:', error);
    }
  }, []);

  return { terms, loaded, addTerm, removeTerm, updateTerm };
}
