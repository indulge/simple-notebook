// Offline-first notebook hook: IndexedDB is primary storage; Google Drive syncs
// when an access token is available. The app is fully functional without a token.
//
// Data flow:
//   Write → IndexedDB immediately → try Drive (fire + forget) → queue on fail
//   Read  → always from IndexedDB
//   Sync  → on token arrival: process queue, pull Drive notebooks / notes

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOCS_PATH, draftStorageKey, slugify } from '@site/src/lib/notes';
import { localDb, type LocalMeta, type LocalNote } from '@site/src/lib/localDb';
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
} from '@site/src/types';

export type WorkspaceView = 'list' | 'edit' | 'new-notebook';

const EMPTY_META: NotebookMetadataState = { titles: {}, order: [], updated: {}, sha: null };
const CLOSED_SAVE: SaveModalState = { open: false, step: 'idle', progress: 0, error: null };
const CLOSED_NB: NotebookModalState = { open: false, step: 'idle', error: null };

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

function toNoteFile(n: LocalNote): NoteFile {
  return { name: n.name, sha: n.driveId, type: 'file', path: n.path };
}

function toMetaState(m: LocalMeta): NotebookMetadataState {
  return { titles: m.titles, order: m.order, updated: m.updated, sha: m.driveMetaId };
}

export function useNotebook(token: string | null) {
  const { notify } = useNotifications();

  const drive = useMemo(() => (token ? new DriveNotebookClient(token) : null), [token]);
  const driveRef = useRef<DriveNotebookClient | null>(null);
  driveRef.current = drive;

  const [dbReady, setDbReady] = useState(false);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedNotebook, setSelectedNotebook] = useState<Notebook | null>(null);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [metadata, setMetadata] = useState<NotebookMetadataState>(EMPTY_META);

  const [view, setView] = useState<WorkspaceView>('list');
  const [editingNote, setEditingNote] = useState<EditingNote | null>(null);

  const [loadingNotebooks] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [loadingNote, setLoadingNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflictBanner] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(0);

  const [saveModal, setSaveModal] = useState<SaveModalState>(CLOSED_SAVE);
  const [notebookModal, setNotebookModal] = useState<NotebookModalState>(CLOSED_NB);
  const [deletingNotebook, setDeletingNotebook] = useState<string | null>(null);

  const syncFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (syncFlashRef.current) clearTimeout(syncFlashRef.current); }, []);

  const flashSync = useCallback(() => {
    if (syncFlashRef.current) clearTimeout(syncFlashRef.current);
    setSyncing(true);
    setSyncProgress(80);
    syncFlashRef.current = setTimeout(() => {
      setSyncProgress(100);
      syncFlashRef.current = setTimeout(() => { setSyncing(false); setSyncProgress(0); }, 300);
    }, 400);
  }, []);

  // ── IndexedDB init ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localDb.getNotebooks().then(names => {
      setNotebooks(names.map(name => ({ name })));
      setDbReady(true);
    });
  }, []);

  // ── Drive sync on token arrival ─────────────────────────────────────────────

  useEffect(() => {
    if (!drive || !dbReady) return;
    let cancelled = false;

    (async () => {
      const ok = await drive.verify();
      if (!ok || cancelled) return;

      setSyncing(true);

      // 1. Process pending sync queue
      const queue = await localDb.getQueue();
      for (const item of queue) {
        if (cancelled) break;
        try {
          if (item.op === 'upsert' && item.content !== undefined) {
            const newId = await drive.putFile(item.path, '', item.content, item.driveId ?? null);
            const note = await localDb.getNote(item.path);
            if (note) await localDb.putNote({ ...note, driveId: newId });
          } else if (item.op === 'delete' && item.driveId) {
            await drive.deleteFile(item.path, item.driveId, '');
          }
          await localDb.dequeue(item.id!);
        } catch { /* leave unprocessed items in queue */ }
      }

      if (cancelled) { setSyncing(false); return; }

      // 2. Pull Drive notebooks → add any missing to local
      try {
        const driveNbs = await drive.listNotebooks();
        for (const nb of driveNbs) {
          await localDb.putNotebook(nb.name);
        }
        const localNames = await localDb.getNotebooks();
        const merged = Array.from(new Set([...localNames, ...driveNbs.map(n => n.name)]));
        if (!cancelled) setNotebooks(merged.map(name => ({ name })));
      } catch { /* non-critical */ }

      setSyncing(false);
    })();

    return () => { cancelled = true; };
  }, [drive, dbReady]);

  // ── Internal Drive helpers ──────────────────────────────────────────────────

  // Write a note to Drive and update IDB driveId; enqueue on failure.
  const driveUpsert = useCallback(async (
    note: LocalNote,
    localMetaId: string | null,
    notebook: string,
    titles: Record<string, string>,
    order: string[],
    updated: Record<string, number>,
  ) => {
    const d = driveRef.current;
    if (!d) return;
    try {
      const newId = await d.putFile(note.path, '', note.content, note.driveId);
      await localDb.putNote({ ...note, driveId: newId });
      const metaId = await d.putMetadata(notebook, titles, order, updated, localMetaId);
      const meta = await localDb.getMetadata(notebook);
      if (meta) await localDb.putMetadata({ ...meta, driveMetaId: metaId });
    } catch {
      await localDb.enqueue({
        op: 'upsert', path: note.path, notebook, name: note.name,
        content: note.content, driveId: note.driveId, updatedAt: note.updatedAt,
      });
    }
  }, []);

  // ── Load notebook from local DB ──────────────────────────────────────────────

  const loadNotebook = useCallback(async (nb: Notebook) => {
    setLoadingNotes(true);
    const [localNotes, localMeta] = await Promise.all([
      localDb.getNotes(nb.name),
      localDb.getMetadata(nb.name),
    ]);
    setNotes(localNotes.map(toNoteFile));
    setMetadata(localMeta ? toMetaState(localMeta) : EMPTY_META);
    setLoadingNotes(false);

    // Background: pull Drive notes for this notebook (if token available)
    const d = driveRef.current;
    if (!d) return;
    try {
      const [driveNotes, driveMeta] = await Promise.all([
        d.listNotes(nb.name),
        d.getMetadata(nb.name),
      ]);

      const localNoteMap = new Map(localNotes.map(n => [n.name, n]));

      for (const dn of driveNotes) {
        const ln = localNoteMap.get(dn.name);
        const driveUpdated = driveMeta.updated[dn.name] ?? 0;
        const localUpdated = ln?.updatedAt ?? 0;
        if (!ln || driveUpdated > localUpdated) {
          try {
            const { content } = await d.getNote(nb.name, dn.name);
            await localDb.putNote({
              path: dn.path, notebook: nb.name, name: dn.name,
              content, updatedAt: driveUpdated || Date.now(), driveId: dn.sha,
            });
          } catch { /* skip if fetch fails */ }
        }
      }

      // Update metadata and notes state from Drive if Drive is overall newer
      const maxDriveTs = Object.values(driveMeta.updated).reduce((a, b) => Math.max(a, b), 0);
      const maxLocalTs = localMeta ? Object.values(localMeta.updated).reduce((a, b) => Math.max(a, b), 0) : 0;
      if (maxDriveTs > maxLocalTs) {
        const freshMeta: LocalMeta = {
          notebook: nb.name,
          titles: driveMeta.titles, order: driveMeta.order, updated: driveMeta.updated,
          driveMetaId: driveMeta.sha,
        };
        await localDb.putMetadata(freshMeta);
        const freshNotes = await localDb.getNotes(nb.name);
        setNotes(freshNotes.map(toNoteFile));
        setMetadata(toMetaState(freshMeta));
      }
    } catch { /* Drive pull failures don't affect local-only mode */ }
  }, []);

  // ── Notebooks ───────────────────────────────────────────────────────────────

  const openNewNotebook = useCallback(() => setView('new-notebook'), []);

  const selectNotebook = useCallback((nb: Notebook) => {
    setSelectedNotebook(nb);
    setView('list');
    setMetadata(EMPTY_META);
    loadNotebook(nb);
  }, [loadNotebook]);

  const createNotebook = useCallback(async (name: string) => {
    const slug = slugify(name);
    setNotebookModal({ open: true, step: 'creating', error: null });
    try {
      await localDb.putNotebook(slug);
      const nb: Notebook = { name: slug };
      setNotebooks(prev => prev.some(n => n.name === slug) ? prev : [...prev, nb]);
      setSelectedNotebook(nb);
      setView('list');
      setMetadata(EMPTY_META);
      setNotes([]);
      setNotebookModal({ open: true, step: 'done', error: null });
      setTimeout(() => setNotebookModal(CLOSED_NB), 1200);

      // Create Drive folder in background (best-effort)
      driveRef.current?.createNotebookCategory(slug, name, 0).catch(() => {});
    } catch (e) {
      setNotebookModal({ open: true, step: 'error', error: errMsg(e, 'Unknown error') });
    }
  }, []);

  const deleteNotebook = useCallback(async (nb: Notebook) => {
    setDeletingNotebook(nb.name);
    try {
      const driveId = (await localDb.getMetadata(nb.name))?.driveMetaId ?? null;
      await localDb.deleteNotebook(nb.name);
      setNotebooks(prev => prev.filter(n => n.name !== nb.name));
      if (selectedNotebook?.name === nb.name) {
        setSelectedNotebook(null);
        setNotes([]);
        setMetadata(EMPTY_META);
        setEditingNote(null);
        setView('list');
      }
      notify(`Notebook "${nb.name}" deleted.`, 'success');
      // Delete Drive folder in background (best-effort)
      driveRef.current?.deleteNotebook(nb.name).catch(() => {
        if (driveId) localDb.enqueue({ op: 'delete', path: nb.name, notebook: nb.name, name: nb.name, driveId, updatedAt: Date.now() });
      });
    } catch (e) {
      notify(errMsg(e, 'Failed to delete the notebook.'), 'error');
    } finally {
      setDeletingNotebook(null);
    }
  }, [selectedNotebook, notify]);

  // ── Quick capture ────────────────────────────────────────────────────────────

  const quickCapture = useCallback(async () => {
    const name = 'inbox';
    let nb = notebooks.find(n => n.name === name);
    if (!nb) {
      await localDb.putNotebook(name);
      nb = { name };
      setNotebooks(prev => prev.some(n => n.name === name) ? prev : [...prev, nb!]);
      driveRef.current?.createNotebookCategory(name, 'Inbox', 0).catch(() => {});
    }
    setSelectedNotebook(nb);
    setMetadata(EMPTY_META);
    await loadNotebook(nb);
    setEditingNote(null);
    setView('edit');
  }, [notebooks, loadNotebook]);

  // ── Note content helpers ─────────────────────────────────────────────────────

  const buildMeta = useCallback((
    prev: NotebookMetadataState,
    fileName: string,
    title: string,
  ) => ({
    titles: { ...prev.titles, [fileName]: title },
    order: prev.order.includes(fileName) ? prev.order : [...prev.order, fileName],
    updated: { ...prev.updated, [fileName]: Date.now() },
  }), []);

  const commitMeta = useCallback(async (
    nb: string,
    titles: Record<string, string>,
    order: string[],
    updated: Record<string, number>,
    currentDriveMetaId: string | null,
  ) => {
    const current = await localDb.getMetadata(nb);
    const next: LocalMeta = {
      notebook: nb,
      titles, order, updated,
      driveMetaId: currentDriveMetaId ?? current?.driveMetaId ?? null,
    };
    await localDb.putMetadata(next);
    setMetadata({ titles, order, updated, sha: next.driveMetaId });
    return next;
  }, []);

  // ── Deletion ─────────────────────────────────────────────────────────────────

  const deleteNote = useCallback(async (note: NoteFile) => {
    if (!selectedNotebook) return;
    const localNote = await localDb.getNote(note.path);
    await localDb.deleteNote(note.path);

    const newTitles = { ...metadata.titles };
    delete newTitles[note.name];
    const newUpdated = { ...metadata.updated };
    delete newUpdated[note.name];
    const newOrder = metadata.order.filter(n => n !== note.name);

    await commitMeta(selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha);
    setNotes(prev => prev.filter(n => n.name !== note.name));
    notify('Note deleted.', 'success');

    const d = driveRef.current;
    const driveId = localNote?.driveId ?? note.sha;
    if (d && driveId) {
      d.deleteFile(note.path, driveId, '').catch(() => {
        // If Drive delete fails we can't easily undo; log but don't resurface.
      });
      d.putMetadata(selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha)
        .catch(() => {});
    }
  }, [selectedNotebook, metadata, commitMeta, notify]);

  // ── Move note ────────────────────────────────────────────────────────────────

  const moveNote = useCallback(async (note: NoteFile, target: Notebook) => {
    if (!selectedNotebook || target.name === selectedNotebook.name) return;
    const localNote = await localDb.getNote(note.path);
    if (!localNote) return;

    const title = metadata.titles[note.name] || note.name.replace(/\.mdx?$/, '');
    const newPath = `${DOCS_PATH}/${target.name}/${note.name}`;

    // Write to target notebook in IDB
    await localDb.putNote({ ...localNote, path: newPath, notebook: target.name, driveId: null });
    await localDb.deleteNote(note.path);

    const targetMeta = await localDb.getMetadata(target.name);
    const tMeta: LocalMeta = {
      notebook: target.name,
      titles: { ...(targetMeta?.titles ?? {}), [note.name]: title },
      order: [...(targetMeta?.order ?? []), note.name],
      updated: { ...(targetMeta?.updated ?? {}), [note.name]: Date.now() },
      driveMetaId: targetMeta?.driveMetaId ?? null,
    };
    await localDb.putMetadata(tMeta);

    const newTitles = { ...metadata.titles };
    delete newTitles[note.name];
    const newUpdated = { ...metadata.updated };
    delete newUpdated[note.name];
    const newOrder = metadata.order.filter(n => n !== note.name);
    await commitMeta(selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha);
    setNotes(prev => prev.filter(n => n.name !== note.name));
    notify(`Moved "${title}" to ${target.name}.`, 'success');

    // Sync to Drive in background
    const d = driveRef.current;
    if (d) {
      const newLocalNote = await localDb.getNote(newPath);
      if (newLocalNote) driveUpsert(newLocalNote, tMeta.driveMetaId, target.name, tMeta.titles, tMeta.order, tMeta.updated).catch(() => {});
      const oldDriveId = localNote.driveId ?? note.sha;
      if (oldDriveId) d.deleteFile(note.path, oldDriveId, '').catch(() => {});
    }
  }, [selectedNotebook, metadata, commitMeta, notify, driveUpsert]);

  // ── Image upload ─────────────────────────────────────────────────────────────

  const uploadImage = useCallback(async (file: File): Promise<string> => {
    const d = driveRef.current;
    if (!d) throw new Error('Connect Google Drive to upload images.');
    const rawExt = file.name.includes('.') ? file.name.split('.').pop()! : 'png';
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const base = slugify(file.name.replace(/\.[^.]*$/, '')) || 'image';
    const name = `${base}-${Date.now()}.${ext}`;
    return d.putBinaryFile(`static/img/notes/${name}`, '', await file.arrayBuffer());
  }, []);

  // ── Refresh ──────────────────────────────────────────────────────────────────

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setRefreshProgress(0);
    let prog = 0;
    const tick = setInterval(() => { prog = Math.min(prog + 3, 85); setRefreshProgress(prog); }, 80);

    const names = await localDb.getNotebooks();
    setNotebooks(names.map(name => ({ name })));

    if (selectedNotebook) {
      await loadNotebook(selectedNotebook);
    }

    if (view === 'edit' && editingNote) {
      const localNote = await localDb.getNote(editingNote.path);
      if (localNote) {
        setEditingNote(prev => prev ? {
          ...prev,
          sha: localNote.driveId,
          content: localNote.content,
          _refreshKey: (prev._refreshKey || 0) + 1,
        } : null);
      }
    }

    clearInterval(tick);
    setRefreshProgress(100);
    setTimeout(() => { setRefreshing(false); setRefreshProgress(0); }, 500);
  }, [selectedNotebook, loadNotebook, view, editingNote]);

  // ── Full-screen editor ────────────────────────────────────────────────────────

  const openNote = useCallback(async (note: NoteFile) => {
    if (!selectedNotebook || loadingNote) return;
    setLoadingNote(note.name);
    try {
      const localNote = await localDb.getNote(note.path);
      if (!localNote) throw new Error('Note not found locally.');
      setEditingNote({
        path: note.path,
        sha: localNote.driveId,
        title: metadata.titles[note.name] || '',
        content: localNote.content,
      });
      setView('edit');
    } catch (e) {
      notify(errMsg(e, 'Failed to load note.'), 'error');
    } finally {
      setLoadingNote(null);
    }
  }, [selectedNotebook, loadingNote, metadata.titles, notify]);

  const loadNoteContent = useCallback(async (note: NoteFile): Promise<NoteContent> => {
    const localNote = await localDb.getNote(note.path);
    if (!localNote) throw new Error('Note not found.');
    return { content: localNote.content, sha: localNote.driveId };
  }, []);

  // ── Inline (tile) save ────────────────────────────────────────────────────────

  const saveNoteContent = useCallback(async (
    note: NoteFile, title: string, content: string, _sha: string | null,
  ): Promise<string | null> => {
    if (!selectedNotebook) throw new Error('No notebook selected.');
    const noteTitle = title.trim() || 'untitled';
    const now = Date.now();
    const existing = await localDb.getNote(note.path);
    const updatedNote: LocalNote = {
      path: note.path, notebook: selectedNotebook.name, name: note.name,
      content, updatedAt: now, driveId: existing?.driveId ?? null,
    };
    await localDb.putNote(updatedNote);

    const newMeta = buildMeta(metadata, note.name, noteTitle);
    const localMeta = await commitMeta(selectedNotebook.name, newMeta.titles, newMeta.order, newMeta.updated, metadata.sha);

    driveUpsert(updatedNote, localMeta.driveMetaId, selectedNotebook.name, newMeta.titles, newMeta.order, newMeta.updated).catch(() => {});
    return updatedNote.driveId;
  }, [selectedNotebook, metadata, buildMeta, commitMeta, driveUpsert]);

  const reorderNotes = useCallback(async (newOrder: string[]) => {
    if (!selectedNotebook) return;
    setMetadata(prev => ({ ...prev, order: newOrder }));
    const meta = await localDb.getMetadata(selectedNotebook.name);
    if (!meta) return;
    const updated: LocalMeta = { ...meta, order: newOrder };
    await localDb.putMetadata(updated);
    const d = driveRef.current;
    if (d) {
      d.putMetadata(selectedNotebook.name, meta.titles, newOrder, meta.updated, meta.driveMetaId)
        .then(id => {
          if (id) localDb.putMetadata({ ...updated, driveMetaId: id });
        }).catch(() => {});
    }
  }, [selectedNotebook]);

  const createNoteInline = useCallback(async (
    preceding: string[], following: string[], title: string, content: string,
  ) => {
    if (!selectedNotebook) throw new Error('No notebook selected.');
    const noteTitle = title.trim() || 'untitled';
    const fileName = `${slugify(noteTitle)}-${Date.now()}.md`;
    const filePath = `${DOCS_PATH}/${selectedNotebook.name}/${fileName}`;
    const now = Date.now();

    const newNote: LocalNote = {
      path: filePath, notebook: selectedNotebook.name, name: fileName,
      content, updatedAt: now, driveId: null,
    };
    await localDb.putNote(newNote);

    const newOrder = [...preceding, fileName, ...following];
    const newTitles = { ...metadata.titles, [fileName]: noteTitle };
    const newUpdated = { ...metadata.updated, [fileName]: now };
    const localMeta = await commitMeta(selectedNotebook.name, newTitles, newOrder, newUpdated, metadata.sha);

    setNotes(prev => prev.some(n => n.name === fileName)
      ? prev : [...prev, toNoteFile(newNote)]);
    notify('Note created.', 'success');
    flashSync();

    driveUpsert(newNote, localMeta.driveMetaId, selectedNotebook.name, newTitles, newOrder, newUpdated).catch(() => {});
  }, [selectedNotebook, metadata, commitMeta, notify, flashSync, driveUpsert]);

  // ── Full-screen save ──────────────────────────────────────────────────────────

  const saveNote = useCallback(async (title: string, content: string) => {
    if (!selectedNotebook) return;
    setSaving(true);

    const noteTitle = title.trim() || 'untitled';
    const fileName = editingNote
      ? (editingNote.path.split('/').pop() ?? '')
      : `${slugify(noteTitle)}-${Date.now()}.md`;
    const filePath = editingNote
      ? editingNote.path
      : `${DOCS_PATH}/${selectedNotebook.name}/${fileName}`;
    const now = Date.now();

    try {
      const existing = editingNote ? await localDb.getNote(filePath) : null;
      const updatedNote: LocalNote = {
        path: filePath, notebook: selectedNotebook.name, name: fileName,
        content, updatedAt: now, driveId: existing?.driveId ?? null,
      };
      await localDb.putNote(updatedNote);

      if (!editingNote) {
        try { localStorage.removeItem(draftStorageKey(`new:${selectedNotebook.name}`)); } catch {}
      }

      setEditingNote(prev =>
        prev ? { ...prev, title, content }
             : { path: filePath, sha: null, title, content },
      );

      const newMeta = buildMeta(metadata, fileName, noteTitle);
      const localMeta = await commitMeta(selectedNotebook.name, newMeta.titles, newMeta.order, newMeta.updated, metadata.sha);

      setNotes(prev => prev.some(n => n.name === fileName)
        ? prev.map(n => n.name === fileName ? toNoteFile(updatedNote) : n)
        : [...prev, toNoteFile(updatedNote)],
      );

      flashSync();

      // Async Drive sync (non-blocking)
      driveUpsert(updatedNote, localMeta.driveMetaId, selectedNotebook.name, newMeta.titles, newMeta.order, newMeta.updated)
        .then(async () => {
          // Update editingNote sha with Drive file ID from IDB after sync
          const synced = await localDb.getNote(filePath);
          if (synced?.driveId) {
            setEditingNote(prev => prev ? { ...prev, sha: synced.driveId } : null);
          }
        }).catch(() => {});
    } catch (e) {
      const message = errMsg(e, 'Save failed.');
      setSaveModal({ open: true, step: 'error', progress: 0, error: message });
      notify(message, 'error');
    } finally {
      setSaving(false);
    }
  }, [selectedNotebook, editingNote, metadata, buildMeta, commitMeta, notify, flashSync, driveUpsert]);

  // ── View helpers ──────────────────────────────────────────────────────────────

  const showList = useCallback(() => setView('list'), []);
  const clearConflict = useCallback(() => {}, []);
  const closeSaveModal = useCallback(() => setSaveModal(CLOSED_SAVE), []);
  const closeNotebookModal = useCallback(() => setNotebookModal(CLOSED_NB), []);
  const openNewNote = useCallback(() => { setEditingNote(null); setView('edit'); }, []);

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
    dbReady,
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

export type UseNotebook = ReturnType<typeof useNotebook>;
