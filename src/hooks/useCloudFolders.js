import { useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';

// Palette keys shared with the UI (App.js FOLDER_COLORS). Stored as a key so the
// theme controls the actual color values.
export const DEFAULT_FOLDER_COLOR = 'indigo';

const normalizeFolder = (row) => ({
  id: row?.id,
  name: row?.name || '未命名文件夹',
  color: row?.color || DEFAULT_FOLDER_COLOR,
  createdAt: row?.created_at || null,
});

const supabaseErrorText = (error) => {
  if (!error) return '未知错误';
  const parts = [error.message, error.code, error.details, error.hint].filter(Boolean);
  return parts.length ? parts.join(' | ') : String(error);
};

export function useCloudFolders(userId) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadFolders = useCallback(async () => {
    if (!userId) return [];
    setLoading(true);
    const { data, error } = await supabase
      .from('folders')
      .select('id, name, color, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    setLoading(false);
    if (error) {
      console.error('Failed to load folders:', error);
      return [];
    }
    const normalized = (data || []).map(normalizeFolder);
    setFolders(normalized);
    return normalized;
  }, [userId]);

  const createFolder = useCallback(
    async (name, color = DEFAULT_FOLDER_COLOR) => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from('folders')
        .insert({ user_id: userId, name: String(name || '').trim() || '新建文件夹', color })
        .select('id, name, color, created_at')
        .single();
      if (error) {
        console.error('Failed to create folder:', error);
        throw new Error(`创建文件夹失败：${supabaseErrorText(error)}`);
      }
      const folder = normalizeFolder(data);
      setFolders((prev) => [...prev, folder]);
      return folder;
    },
    [userId]
  );

  const updateFolder = useCallback(async (folderId, updates) => {
    const dbUpdates = {};
    if (updates.name !== undefined) dbUpdates.name = String(updates.name || '').trim() || '未命名文件夹';
    if (updates.color !== undefined) dbUpdates.color = updates.color;
    dbUpdates.updated_at = new Date().toISOString();

    const { error } = await supabase.from('folders').update(dbUpdates).eq('id', folderId);
    if (!error) {
      setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, ...updates } : f)));
    } else {
      console.error('Failed to update folder:', error);
    }
    return { error };
  }, []);

  // Deleting a folder leaves its sessions as 未归档 (sessions.folder_id → NULL
  // via ON DELETE SET NULL).
  const deleteFolder = useCallback(async (folderId) => {
    const { error } = await supabase.from('folders').delete().eq('id', folderId);
    if (!error) {
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
    } else {
      console.error('Failed to delete folder:', error);
    }
    return { error };
  }, []);

  return { folders, loading, loadFolders, createFolder, updateFolder, deleteFolder };
}
