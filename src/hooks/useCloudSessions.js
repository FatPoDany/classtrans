import { useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';

const PAGE_SIZE = 20;

// Build a human-readable string from a Supabase/PostgREST error so failures
// (e.g. missing table GRANTs / RLS policies) are visible instead of silent.
const supabaseErrorText = (error) => {
  if (!error) return '未知错误';
  const parts = [error.message, error.code, error.details, error.hint].filter(Boolean);
  return parts.length ? parts.join(' | ') : String(error);
};

const normalizeTranscript = (row, fallbackIndex = 0) => ({
  id: row?.id || `${row?.session_id || 'transcript'}-${fallbackIndex}`,
  speaker: row?.speaker || '',
  en: row?.en_text || '',
  zh: row?.zh_text || '',
  isPolished: row?.is_polished === true,
  confidence: Number(row?.confidence || 0),
});

const normalizeSession = (row) => {
  const transcripts = Array.isArray(row?.transcripts)
    ? [...row.transcripts].sort(
        (a, b) => Number(a?.sort_order || 0) - Number(b?.sort_order || 0)
      )
    : [];

  return {
    id: row?.id,
    fileName: row?.id,
    title: row?.title || 'Untitled Session',
    summary: row?.summary || '',
    createdAt: row?.created_at || row?.createdAt || new Date().toISOString(),
    updatedAt: row?.updated_at || row?.updatedAt || null,
    durationSec: Number(row?.duration_sec || row?.durationSec || 0),
    wordCount: Number(row?.word_count || row?.wordCount || 0),
    mode: row?.mode || 'mic',
    isTemporary: false,
    transcripts: transcripts.map(normalizeTranscript),
  };
};

const buildTranscriptRows = (sessionId, transcripts = []) =>
  (Array.isArray(transcripts) ? transcripts : []).map((t, i) => ({
    session_id: sessionId,
    speaker: t?.speaker || '',
    en_text: t?.en || '',
    zh_text: t?.zh || '',
    is_polished: !!t?.isPolished,
    confidence: Number(t?.confidence || 0),
    sort_order: i,
  }));

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
      const sessionRows = data || [];
      const sessionIds = sessionRows.map(s => s.id).filter(Boolean);
      const transcriptsBySession = new Map();

      if (sessionIds.length > 0) {
        const { data: txRows, error: txError } = await supabase
          .from('transcripts')
          .select('id, session_id, speaker, en_text, zh_text, is_polished, confidence, sort_order, created_at')
          .in('session_id', sessionIds)
          .order('sort_order', { ascending: true });

        if (txError) {
          console.error('Failed to load session transcripts:', txError);
        } else {
          for (const row of txRows || []) {
            const key = row.session_id;
            if (!transcriptsBySession.has(key)) transcriptsBySession.set(key, []);
            transcriptsBySession.get(key).push(row);
          }
        }
      }

      const normalized = sessionRows.map(session =>
        normalizeSession({
          ...session,
          transcripts: transcriptsBySession.get(session.id) || [],
        })
      );

      if (offset === 0) {
        setSessions(normalized);
      } else {
        setSessions(prev => [...prev, ...normalized]);
      }
      setHasMore(sessionRows.length === PAGE_SIZE);
      setLoading(false);
      return normalized;
    } else {
      console.error('Failed to load sessions:', error);
    }
    setLoading(false);
    return [];
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

    return normalizeSession({
      ...sessionRes.data,
      transcripts: transcriptsRes.data || [],
    });
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
      // Surface the real cause (e.g. missing GRANT / RLS policy) so the caller
      // can fall back to a temporary session and the error is diagnosable.
      throw new Error(`保存会话失败：${supabaseErrorText(sessionError)}`);
    }

    // Insert transcripts in batch
    let savedTranscripts = [];
    if (transcripts && transcripts.length > 0) {
      const rows = buildTranscriptRows(session.id, transcripts);

      const { data: txData, error: txError } = await supabase
        .from('transcripts')
        .insert(rows)
        .select('id, session_id, speaker, en_text, zh_text, is_polished, confidence, sort_order, created_at');
      if (txError) {
        console.error('Failed to save transcripts:', txError);
        // The session row was created but its transcripts could not be saved.
        // Roll it back so it doesn't reappear empty after a refresh, then
        // surface the real error instead of reporting a hollow success.
        await supabase.from('sessions').delete().eq('id', session.id);
        throw new Error(`保存转录记录失败：${supabaseErrorText(txError)}`);
      }
      savedTranscripts = txData || [];
    }

    const normalized = normalizeSession({
      ...session,
      transcripts: savedTranscripts,
    });

    // Prepend to local list
    setSessions(prev => [normalized, ...prev]);
    return normalized;
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
    if (updates.confidence !== undefined) dbUpdates.confidence = updates.confidence;

    const { error } = await supabase
      .from('transcripts')
      .update(dbUpdates)
      .eq('id', transcriptId);

    if (!error) {
      setSessions(prev =>
        prev.map(session => ({
          ...session,
          transcripts: (session.transcripts || []).map(t =>
            t.id === transcriptId ? { ...t, ...updates } : t
          ),
        }))
      );
    }
    return { error };
  }, []);

  // Replace all transcript rows for a session, used when AI splits one bubble
  // into several polished speaker segments.
  const replaceTranscripts = useCallback(async (sessionId, transcripts) => {
    const { error: deleteError } = await supabase
      .from('transcripts')
      .delete()
      .eq('session_id', sessionId);

    if (deleteError) {
      console.error('Failed to replace transcripts:', deleteError);
      return { data: null, error: deleteError };
    }

    const rows = buildTranscriptRows(sessionId, transcripts);
    let normalizedTranscripts = [];

    if (rows.length > 0) {
      const { data, error } = await supabase
        .from('transcripts')
        .insert(rows)
        .select('id, session_id, speaker, en_text, zh_text, is_polished, confidence, sort_order, created_at');

      if (error) {
        console.error('Failed to insert replacement transcripts:', error);
        return { data: null, error };
      }
      normalizedTranscripts = (data || []).map(normalizeTranscript);
    }

    setSessions(prev =>
      prev.map(session =>
        session.id === sessionId
          ? { ...session, transcripts: normalizedTranscripts }
          : session
      )
    );

    return { data: normalizedTranscripts, error: null };
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
    replaceTranscripts,
    deleteSession,
  };
}
