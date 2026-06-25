// Notebook workspace data + control layer backed by Google Drive.
// Owns all state the editor needs (notebooks, notes, metadata, the open editor
// note, loading/save/modal flags) and exposes typed operations that drive the
// Drive folder tree through `DriveNotebookClient`.
//
// Compared to the old GitHub-backed hook:
//   • No polling after writes — Drive is immediately consistent.
//   • No deploy-status tracking — Drive has no GitHub Actions equivalent.
//   • No SHA-based conflict detection — Drive uses last-write-wins.
//   • `syncing` / `syncProgress` are a brief post-save animation only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOCS_PATH, draftStorageKey, slugify } from '@site/src/lib/notes';
import { DriveNotebookClient } from '@site/src/services/googledrive';
import { useNotifications } from '@site/src/hooks/useNotifications';
import type {
  EditingNote,
  Notebook,
  NoteContent,
  NoteFile,
  NotebookMetadataState,
  NotebookModalState,
  SaveModalState,
  SyncMode,
} from '@site/src/types';

export type WorkspaceView = 'list' | 'edit' | 'new-notebook';

const EMPTY_METADATA: NotebookMetadataState = { titles: {}, order: [], updated: {}, sha: null };
const CLOSED_SAVE_MODAL: SaveModalState = { open: false, step: 'idle', progress: 0, error: null };
const CLOSED_NOTEBOOK_MODAL: NotebookModalState = { open: false, step: 'idle', error: null };

const errMsg = (e: unknown, fallback: string): string =>
  e instanceof Error ? e.message : fallback;

export function useDriveNotebook(token: string | null) {
  const { notify } = useNotifications();

  const client = useMemo(
    () => (token ? new DriveNotebookClient(token) : null),
    [token],
  );

  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedNotebook, setSelectedNotebook] = useState<Notebook | null>(null);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [metadata, setMetadata] = useState<NotebookMetadataState>(EMPTY_METADATA);

  const [view, setView] = useState<WorkspaceView>('list');
  const [editingNote, setEditingNote] = useState<EditingNote | null>(null);

  const [loadingNotebooks, setLoadingNotebooks] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [loadingNote, setLoadingNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflictBanner] = useState(false); // Drive uses last-write-wins; always false

  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(0);

  const [saveModal, setSaveModal] = useState<SaveModalState>(CLOSED_SAVE_MODAL);
  const [notebookModal, setNotebookModal] = useState<NotebookModalState>(CLOSED_NOTEBOOK_MODAL);

  const [deletingNotebook, setDeletingNotebook] = useState<string | null>(null);

  const syncFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => { if (syncFlashRef.current) clearTimeout(syncFlashRef.current); },
    [],
  );

  /** Brief post-write visual animation (Drive is immediately consistent). */
  const flashSync = useCallback(() => {
    if (syncFlashRef.current) clearTimeout(syncFlashRef.current);
    setSyncing(true);
    setSyncProgress(80);
    syncFlashRef.current = setTimeout(() => {
      setSyncProgress(100);
      syncFlashRef.current = setTimeout(() => {
        setSyncing(false);
        setSyncProgress(0);
      }, 300);
    }, 400);
  }, []);

  // ── notebooks / notes / metadata fetching ──────────────────────────────────

  const fetchNotebooks = useCallback(async () => {
    if (!client) return;
    setLoadingNotebooks(true);
    try {
      setNotebooks(await client.listNotebooks());
    } catch (e) {
      notify(errMsg(e, 'Could not load notebooks.'), 'error');
    } finally {
      setLoadingNotebooks(false);
    }
  }, [client, notify]);

  useEffect(() => {
    if (token) fetchNotebooks();
  }, [token, fetchNotebooks]);

  const fetchNotes = useCallback(
    async (notebook: Notebook) => {
      if (!client) return;
      setLoadingNotes(true);
      try {
        setNotes(await client.listNotes(notebook.name));
      } catch (e) {
        notify(errMsg(e, 'Could not load notes.'), 'error');
      } finally {
        setLoadingNotes(false);
      }
    },
    [client, notify],
  );

  const fetchMetadata = useCallback(
    async (notebook: Notebook) => {
      if (!client) return;
      setMetadata(await client.getMetadata(notebook.name));
    },
    [client],
  );

  const selectNotebook = useCallback(
    (nb: Notebook) => {
      setSelectedNotebook(nb);
      setView('list');
      setMetadata(EMPTY_METADATA);
      fetchNotes(nb);
      fetchMetadata(nb);
    },
    [fetchNotes, fetchMetadata],
  );

  // ── notebook creation ──────────────────────────────────────────────────────

  const openNewNotebook = useCallback(() => setView('new-notebook'), []);

  const createNotebook = useCallback(
    async (name: string) => {
      if (!client) return;
      const slug = slugify(name);
      setNotebookModal({ open: true, step: 'creating', error: null });
      try {
        await client.createNotebookCategory(slug, name, notebooks.length + 2);
        const nb: Notebook = { name: slug };
        setNotebooks(prev => prev.some(n => n.name === slug) ? prev : [...prev, nb]);
        setSelectedNotebook(nb);
        setView('list');
        setMetadata(EMPTY_METADATA);
        setNotes([]);
        setNotebookModal({ open: true, step: 'done', error: null });
        setTimeout(() => setNotebookModal(CLOSED_NOTEBOOK_MODAL), 1200);
      } catch (e) {
        setNotebookModal({ open: true, step: 'error', error: errMsg(e, 'Unknown error') });
      }
    },
    [client, notebooks.length],
  );

  // ── quick capture ──────────────────────────────────────────────────────────

  const quickCapture = useCallback(async () => {
    if (!client) return;
    const name = 'inbox';
    let nb = notebooks.find(n => n.name === name);
    if (!nb) {
      try {
        await client.createNotebookCategory(name, 'Inbox', notebooks.length + 2);
      } catch { /* folder may already exist — selecting it still works */ }
      nb = { name };
      setNotebooks(prev => prev.some(n => n.name === name) ? prev : [...prev, { name }]);
    }
    setSelectedNotebook(nb);
    setMetadata(EMPTY_METADATA);
    fetchNotes(nb);
    fetchMetadata(nb);
    setEditingNote(null);
    setView('edit');
  }, [client, notebooks, fetchNotes, fetchMetadata]);

  // ── deletion ─────────────────────────────────────────────────────────────

  const deleteNote = useCallback(
    async (note: NoteFile) => {
      if (!client || !selectedNotebook) return;
      if (!note.sha) {
        notify('Cannot delete: missing file ID. Refresh and try again.', 'error');
        return;
      }
      try {
        await client.deleteFile(note.path, note.sha, `Delete note: ${note.name}`);
        const newTitles = { ...metadata.titles };
        delete newTitles[note.name];
        const newUpdated = { ...metadata.updated };
        delete newUpdated[note.name];
        const newOrder = metadata.order.filter(n => n !== note.name);
        const newSha = await client.putMetadata(
          selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha,
        );
        setMetadata({ titles: newTitles, order: newOrder, updated: newUpdated, sha: newSha });
        setNotes(prev => prev.filter(n => n.name !== note.name));
        notify('Note deleted.', 'success');
      } catch (e) {
        notify(errMsg(e, 'Delete failed.'), 'error');
      }
    },
    [client, selectedNotebook, metadata, notify],
  );

  const deleteNotebook = useCallback(
    async (nb: Notebook) => {
      if (!client) return;
      setDeletingNotebook(nb.name);
      try {
        await client.deleteNotebook(nb.name);
        setNotebooks(prev => prev.filter(n => n.name !== nb.name));
        if (selectedNotebook?.name === nb.name) {
          setSelectedNotebook(null);
          setNotes([]);
          setMetadata(EMPTY_METADATA);
          setEditingNote(null);
          setView('list');
        }
        notify(`Notebook "${nb.name}" deleted.`, 'success');
      } catch (e) {
        notify(errMsg(e, 'Failed to delete the notebook.'), 'error');
        fetchNotebooks();
      } finally {
        setDeletingNotebook(null);
      }
    },
    [client, selectedNotebook, notify, fetchNotebooks],
  );

  // ── move a note to another notebook ─────────────────────────────────────────

  const moveNote = useCallback(
    async (note: NoteFile, target: Notebook) => {
      if (!client || !selectedNotebook || target.name === selectedNotebook.name) return;
      const title = metadata.titles[note.name] || note.name.replace(/\.mdx?$/, '');
      try {
        const { content } = await client.getNote(selectedNotebook.name, note.name);
        await client.putFile(
          `${DOCS_PATH}/${target.name}/${note.name}`,
          `Move note: ${title} → ${target.name}`,
          content,
        );
        const targetMeta = await client.getMetadata(target.name);
        await client.putMetadata(
          target.name,
          { ...targetMeta.titles, [note.name]: title },
          targetMeta.order.includes(note.name)
            ? targetMeta.order
            : [...targetMeta.order, note.name],
          { ...targetMeta.updated, [note.name]: Date.now() },
          targetMeta.sha,
        );

        if (note.sha) {
          await client.deleteFile(note.path, note.sha, `Move note: ${title} → ${target.name}`);
        }
        const newTitles = { ...metadata.titles };
        delete newTitles[note.name];
        const newUpdated = { ...metadata.updated };
        delete newUpdated[note.name];
        const newOrder = metadata.order.filter(n => n !== note.name);
        const newSha = await client.putMetadata(
          selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha,
        );
        setMetadata({ titles: newTitles, order: newOrder, updated: newUpdated, sha: newSha });
        setNotes(prev => prev.filter(n => n.name !== note.name));
        notify(`Moved "${title}" to ${target.name}.`, 'success');
      } catch (e) {
        notify(errMsg(e, 'Move failed.'), 'error');
      }
    },
    [client, selectedNotebook, metadata, notify],
  );

  // ── image upload ──────────────────────────────────────────────────────────

  const uploadImage = useCallback(
    async (file: File): Promise<string> => {
      if (!client) throw new Error('Not connected to Drive.');
      const rawExt = file.name.includes('.') ? file.name.split('.').pop()! : 'png';
      const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const base = slugify(file.name.replace(/\.[^.]*$/, '')) || 'image';
      const name = `${base}-${Date.now()}.${ext}`;
      // putBinaryFile returns the public Drive URL for the uploaded image
      return client.putBinaryFile(
        `static/img/notes/${name}`,
        `Add image: ${name}`,
        await file.arrayBuffer(),
      );
    },
    [client],
  );

  // ── refresh everything on screen ──────────────────────────────────────────

  const refreshAll = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    setRefreshProgress(0);
    let prog = 0;
    const tick = setInterval(() => {
      prog = Math.min(prog + 3, 85);
      setRefreshProgress(prog);
    }, 80);

    fetchNotebooks();

    let freshTitles: Record<string, string> = {};
    if (selectedNotebook) {
      fetchNotes(selectedNotebook);
      const meta = await client.getMetadata(selectedNotebook.name);
      freshTitles = meta.titles;
      setMetadata(meta);
    }

    if (view === 'edit' && editingNote) {
      try {
        const { content, sha } = await client.getFileByPath(editingNote.path);
        const fileName = editingNote.path.split('/').pop() ?? '';
        const title = freshTitles[fileName] || editingNote.title;
        setEditingNote(prev =>
          prev ? { ...prev, sha, content, title, _refreshKey: (prev._refreshKey || 0) + 1 } : null,
        );
      } catch { /* leave the open note as-is on refresh failure */ }
    }

    clearInterval(tick);
    setRefreshProgress(100);
    setTimeout(() => {
      setRefreshing(false);
      setRefreshProgress(0);
    }, 500);
  }, [client, fetchNotebooks, fetchNotes, selectedNotebook, view, editingNote]);

  // ── full-screen editor ────────────────────────────────────────────────────

  const openNewNote = useCallback(() => {
    setEditingNote(null);
    setView('edit');
  }, []);

  const openNote = useCallback(
    async (note: NoteFile) => {
      if (!client || !selectedNotebook || loadingNote) return;
      setLoadingNote(note.name);
      try {
        const { content, sha } = await client.getNote(selectedNotebook.name, note.name);
        setEditingNote({
          path: `${DOCS_PATH}/${selectedNotebook.name}/${note.name}`,
          sha,
          title: metadata.titles[note.name] || '',
          content,
        });
        setView('edit');
      } catch (e) {
        notify(errMsg(e, 'Failed to load note.'), 'error');
      } finally {
        setLoadingNote(null);
      }
    },
    [client, selectedNotebook, loadingNote, metadata.titles, notify],
  );

  // ── inline (tile) load + save ─────────────────────────────────────────────

  const loadNoteContent = useCallback(
    (note: NoteFile): Promise<NoteContent> => {
      if (!client || !selectedNotebook) return Promise.reject(new Error('No notebook selected.'));
      return client.getNote(selectedNotebook.name, note.name);
    },
    [client, selectedNotebook],
  );

  const commitMetadata = useCallback(
    async (fileName: string, noteTitle: string) => {
      if (!client || !selectedNotebook) return;
      const newTitles = { ...metadata.titles, [fileName]: noteTitle };
      const newOrder = metadata.order.includes(fileName)
        ? metadata.order
        : [...metadata.order, fileName];
      const newUpdated = { ...metadata.updated, [fileName]: Date.now() };
      const newSha = await client.putMetadata(
        selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha,
      );
      setMetadata({ titles: newTitles, order: newOrder, updated: newUpdated, sha: newSha });
    },
    [client, selectedNotebook, metadata],
  );

  const saveNoteContent = useCallback(
    async (note: NoteFile, title: string, content: string, sha: string | null) => {
      if (!client || !selectedNotebook) throw new Error('No notebook selected.');
      const noteTitle = title.trim() || 'untitled';
      const newId = await client.putFile(
        `${DOCS_PATH}/${selectedNotebook.name}/${note.name}`,
        `Update: ${noteTitle}`,
        content,
        sha,
      );
      await commitMetadata(note.name, noteTitle);
      return newId;
    },
    [client, selectedNotebook, commitMetadata],
  );

  const reorderNotes = useCallback(
    async (newOrder: string[]) => {
      if (!client || !selectedNotebook) return;
      setMetadata(prev => ({ ...prev, order: newOrder }));
      try {
        const newSha = await client.putMetadata(
          selectedNotebook.name, metadata.titles, newOrder, metadata.updated, metadata.sha,
        );
        setMetadata(prev => ({ ...prev, order: newOrder, sha: newSha }));
      } catch (e) {
        notify(errMsg(e, 'Could not save the new order.'), 'error');
      }
    },
    [client, selectedNotebook, metadata, notify],
  );

  const createNoteInline = useCallback(
    async (preceding: string[], following: string[], title: string, content: string) => {
      if (!client || !selectedNotebook) throw new Error('No notebook selected.');
      const noteTitle = title.trim() || 'untitled';
      const fileName = `${slugify(noteTitle)}-${Date.now()}.md`;
      const filePath = `${DOCS_PATH}/${selectedNotebook.name}/${fileName}`;
      const newId = await client.putFile(filePath, `Create note: ${noteTitle}`, content);

      const newOrder = [...preceding, fileName, ...following];
      const newTitles = { ...metadata.titles, [fileName]: noteTitle };
      const newUpdated = { ...metadata.updated, [fileName]: Date.now() };
      const newMetaSha = await client.putMetadata(
        selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha,
      );
      setMetadata({ titles: newTitles, order: newOrder, updated: newUpdated, sha: newMetaSha });
      setNotes(prev =>
        prev.some(n => n.name === fileName)
          ? prev
          : [...prev, { name: fileName, sha: newId, type: 'file', path: filePath }],
      );
      notify('Note created.', 'success');
      flashSync();
    },
    [client, selectedNotebook, metadata, notify, flashSync],
  );

  // ── full-screen editor save ───────────────────────────────────────────────

  const saveNote = useCallback(
    async (title: string, content: string) => {
      if (!client || !selectedNotebook) return;
      setSaving(true);

      const noteTitle = title.trim() || 'untitled';
      const fileName = editingNote
        ? (editingNote.path.split('/').pop() ?? '')
        : `${slugify(noteTitle)}-${Date.now()}.md`;
      const filePath = editingNote
        ? editingNote.path
        : `${DOCS_PATH}/${selectedNotebook.name}/${fileName}`;

      try {
        const newId = await client.putFile(
          filePath,
          editingNote ? `Update: ${noteTitle}` : `Create note: ${noteTitle}`,
          content,
          editingNote?.sha ?? null,
        );

        if (!editingNote) {
          try { localStorage.removeItem(draftStorageKey(`new:${selectedNotebook.name}`)); } catch {}
        }

        setEditingNote(prev =>
          prev
            ? { ...prev, sha: newId, title, content }
            : { path: filePath, sha: newId, title, content },
        );
        await commitMetadata(fileName, noteTitle);

        setNotes(prev =>
          prev.some(n => n.name === fileName)
            ? prev.map(n => n.name === fileName ? { ...n, sha: newId ?? n.sha } : n)
            : [...prev, { name: fileName, sha: newId, type: 'file', path: filePath }],
        );

        flashSync();
      } catch (e) {
        const message = errMsg(e, 'Save failed.');
        setSaveModal({ open: true, step: 'error', progress: 0, error: message });
        notify(message, 'error');
      } finally {
        setSaving(false);
      }
    },
    [client, selectedNotebook, editingNote, commitMetadata, notify, flashSync],
  );

  // ── view helpers ──────────────────────────────────────────────────────────

  const showList = useCallback(() => setView('list'), []);
  const clearConflict = useCallback(() => { /* no-op: Drive uses last-write-wins */ }, []);
  const closeSaveModal = useCallback(() => setSaveModal(CLOSED_SAVE_MODAL), []);
  const closeNotebookModal = useCallback(() => setNotebookModal(CLOSED_NOTEBOOK_MODAL), []);

  return {
    notebooks,
    selectedNotebook,
    notes,
    metadata,
    view,
    editingNote,
    loadingNotebooks,
    loadingNotes,
    loadingNote,
    saving,
    conflictBanner,
    syncing,
    syncProgress,
    refreshing,
    refreshProgress,
    saveModal,
    notebookModal,
    deletingNotebook,
    fetchNotebooks,
    selectNotebook,
    openNewNotebook,
    createNotebook,
    deleteNote,
    deleteNotebook,
    moveNote,
    quickCapture,
    uploadImage,
    refreshAll,
    openNewNote,
    openNote,
    loadNoteContent,
    saveNoteContent,
    reorderNotes,
    createNoteInline,
    saveNote,
    showList,
    clearConflict,
    closeSaveModal,
    closeNotebookModal,
  };
}

export type UseDriveNotebook = ReturnType<typeof useDriveNotebook>;
