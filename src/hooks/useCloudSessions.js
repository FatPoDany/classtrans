import { useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';

const PAGE_SIZE = 20;

export function useCloudSessions(userId) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Load sessions (paginated)
  const loadSessions = useCallback(async (offset = 0) => {
    if (!userId) return;
    setLoading(true);

    const { data, error } = await supabase
      .from('sessions')
      .select('id, title, summary, duration_sec, word_count, mode, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!error) {
      if (offset === 0) {
        setSessions(data || []);
      } else {
        setSessions(prev => [...prev, ...(data || [])]);
      }
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setLoading(false);
  }, [userId]);

  // Load more (next page)
  const loadMore = useCallback(() => {
    loadSessions(sessions.length);
  }, [loadSessions, sessions.length]);

  // Get a single session with its transcripts
  const getSession = useCallback(async (sessionId) => {
    const [sessionRes, transcriptsRes] = await Promise.all([
      supabase.from('sessions').select('*').eq('id', sessionId).single(),
      supabase.from('transcripts').select('*').eq('session_id', sessionId).order('sort_order'),
    ]);

    if (sessionRes.error || transcriptsRes.error) {
      console.error('Failed to load session:', sessionRes.error || transcriptsRes.error);
      return null;
    }

    return {
      ...sessionRes.data,
      transcripts: (transcriptsRes.data || []).map(t => ({
        id: t.id,
        speaker: t.speaker || '',
        en: t.en_text || '',
        zh: t.zh_text || '',
        isPolished: t.is_polished,
        confidence: t.confidence,
      })),
    };
  }, []);

  // Save a new session (with transcripts)
  const saveSession = useCallback(async ({ title, summary, durationSec, wordCount, mode, transcripts }) => {
    if (!userId) return null;

    // Insert session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        user_id: userId,
        title: title || 'Untitled Session',
        summary: summary || '',
        duration_sec: durationSec || 0,
        word_count: wordCount || 0,
        mode: mode || 'mic',
      })
      .select()
      .single();

    if (sessionError || !session) {
      console.error('Failed to save session:', sessionError);
      return null;
    }

    // Insert transcripts in batch
    if (transcripts && transcripts.length > 0) {
      const rows = transcripts.map((t, i) => ({
        session_id: session.id,
        speaker: t.speaker || '',
        en_text: t.en || '',
        zh_text: t.zh || '',
        is_polished: !!t.isPolished,
        confidence: t.confidence || 0,
        sort_order: i,
      }));

      const { error: txError } = await supabase.from('transcripts').insert(rows);
      if (txError) {
        console.error('Failed to save transcripts:', txError);
      }
    }

    // Prepend to local list
    setSessions(prev => [session, ...prev]);
    return session;
  }, [userId]);

  // Update session metadata (title, summary)
  const updateSession = useCallback(async (sessionId, updates) => {
    const { error } = await supabase
      .from('sessions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    if (!error) {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, ...updates } : s));
    }
    return { error };
  }, []);

  // Update a single transcript entry
  const updateTranscript = useCallback(async (transcriptId, updates) => {
    const dbUpdates = {};
    if (updates.en !== undefined) dbUpdates.en_text = updates.en;
    if (updates.zh !== undefined) dbUpdates.zh_text = updates.zh;
    if (updates.isPolished !== undefined) dbUpdates.is_polished = updates.isPolished;

    const { error } = await supabase
      .from('transcripts')
      .update(dbUpdates)
      .eq('id', transcriptId);

    return { error };
  }, []);

  // Delete a session (cascades to transcripts)
  const deleteSession = useCallback(async (sessionId) => {
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (!error) {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    }
    return { error };
  }, []);

  return {
    sessions,
    loading,
    hasMore,
    loadSessions,
    loadMore,
    getSession,
    saveSession,
    updateSession,
    updateTranscript,
    deleteSession,
  };
}
