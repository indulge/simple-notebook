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
  NoteMetadata,
  NotebookMetadataState,
  NotebookModalState,
  SaveModalState,
} from '@site/src/types';

export type WorkspaceView = 'list' | 'edit' | 'new-notebook';

const EMPTY_META: NotebookMetadataState = { titles: {}, order: [], updated: {}, tags: {}, sha: null };
const CLOSED_SAVE: SaveModalState = { open: false, step: 'idle', progress: 0, error: null };
const CLOSED_NB: NotebookModalState = { open: false, step: 'idle', error: null };

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

function toNoteFile(n: LocalNote): NoteFile {
  return { name: n.name, sha: n.driveId, type: 'file', path: n.path };
}

function toMetaState(m: LocalMeta): NotebookMetadataState {
  return { titles: m.titles, order: m.order, updated: m.updated, tags: m.tags ?? {}, sha: m.driveMetaId };
}

/**
 * Merge local and Drive metadata per file: for each note, the side with the
 * newer `updated` timestamp wins its title/tags/timestamp. The order comes
 * from the overall-newer side, with the other side's extra files appended.
 * Never discards a file only one side knows about — a note created offline
 * keeps its title and tags even when Drive has newer edits elsewhere.
 */
function mergeMetadata(local: LocalMeta | null, drive: NotebookMetadataState): NoteMetadata {
  const dTags = drive.tags ?? {};
  if (!local) return { titles: drive.titles, order: drive.order, updated: drive.updated, tags: dTags };
  const lTags = local.tags ?? {};

  const files = new Set<string>([
    ...Object.keys(local.updated), ...Object.keys(drive.updated),
    ...Object.keys(local.titles), ...Object.keys(drive.titles),
    ...local.order, ...drive.order,
  ]);

  const titles: Record<string, string> = {};
  const updated: Record<string, number> = {};
  const tags: Record<string, string[]> = {};
  for (const f of files) {
    const lu = local.updated[f] ?? 0;
    const du = drive.updated[f] ?? 0;
    const [t, u, g] = lu >= du
      ? [local.titles[f], lu, lTags[f]]
      : [drive.titles[f], du, dTags[f]];
    if (t !== undefined) titles[f] = t;
    if (u) updated[f] = u;
    if (g?.length) tags[f] = g;
  }

  const maxLocal = Object.values(local.updated).reduce((a, b) => Math.max(a, b), 0);
  const maxDrive = Object.values(drive.updated).reduce((a, b) => Math.max(a, b), 0);
  const [base, other] = maxLocal >= maxDrive ? [local.order, drive.order] : [drive.order, local.order];
  const order = [...base, ...other.filter(f => !base.includes(f))];

  return { titles, order, updated, tags };
}

/**
 * Pull a notebook's notes + metadata from Drive into IndexedDB, keeping
 * whichever side is newer per note (content and metadata are both merged at
 * per-note granularity, so saves landing mid-pull are not clobbered).
 * Returns true when IDB metadata changed (callers should re-read). Shared by
 * the workspace (notebook open) and the GitHub publish flow.
 */
export async function pullNotebookFromDrive(
  d: DriveNotebookClient,
  notebook: string,
): Promise<boolean> {
  const [driveNotes, driveMeta] = await Promise.all([
    d.listNotes(notebook),
    d.getMetadata(notebook),
  ]);

  for (const dn of driveNotes) {
    const driveUpdated = driveMeta.updated[dn.name] ?? 0;
    const ln = await localDb.getNote(dn.path);
    if (!ln || driveUpdated > ln.updatedAt) {
      try {
        const { content } = await d.getNote(notebook, dn.name);
        // Re-check after the fetch — a save may have landed meanwhile.
        const cur = await localDb.getNote(dn.path);
        if (!cur || driveUpdated > cur.updatedAt) {
          await localDb.putNote({
            path: dn.path, notebook, name: dn.name,
            content, updatedAt: driveUpdated || Date.now(), driveId: dn.sha,
          });
        }
      } catch { /* skip if fetch fails */ }
    }
  }

  // Merge metadata against a FRESH local read (the slow per-note loop above
  // may have raced with user saves).
  const localMeta = await localDb.getMetadata(notebook);
  const merged = mergeMetadata(localMeta, driveMeta);
  const next: LocalMeta = {
    notebook,
    ...merged,
    driveMetaId: driveMeta.sha ?? localMeta?.driveMetaId ?? null,
  };
  const before = localMeta
    ? JSON.stringify(toMetaState(localMeta))
    : null;
  if (before === JSON.stringify(toMetaState(next))) return false;
  await localDb.putMetadata(next);
  return true;
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

      // 1. Process pending sync queue. Replays read the CURRENT note from IDB
      // (not the snapshot captured at enqueue time) so a stale item can never
      // overwrite newer content or double-create a file.
      const queue = await localDb.getQueue();
      const touched = new Set<string>();
      for (const item of queue) {
        if (cancelled) break;
        try {
          if (item.op === 'upsert') {
            const note = await localDb.getNote(item.path);
            if (note) {
              const newId = await drive.putFile(note.path, '', note.content, note.driveId);
              await localDb.putNote({ ...note, driveId: newId });
              touched.add(item.notebook);
            }
            // note deleted since it was queued — nothing to push
          } else if (item.op === 'delete' && item.driveId) {
            await drive.deleteFile(item.path, item.driveId, '');
            touched.add(item.notebook);
          } else if (item.op === 'deleteNotebook') {
            await drive.deleteNotebook(item.notebook);
          }
          await localDb.dequeue(item.id!);
        } catch { /* leave unprocessed items in queue */ }
      }

      // Push current metadata for every notebook the queue touched, so titles,
      // order, and tags written while offline reach Drive too.
      for (const nbName of touched) {
        if (cancelled) break;
        try {
          const meta = await localDb.getMetadata(nbName);
          if (meta) {
            const metaId = await drive.putMetadata(
              nbName, meta.titles, meta.order, meta.updated, meta.tags ?? {}, meta.driveMetaId,
            );
            if (metaId) await localDb.putMetadata({ ...meta, driveMetaId: metaId });
          }
        } catch { /* next sync retries */ }
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

  // Write a note to Drive and update IDB driveId; enqueue when offline or on
  // failure so the write syncs once a token arrives.
  const driveUpsert = useCallback(async (
    note: LocalNote,
    localMetaId: string | null,
    notebook: string,
    meta: NoteMetadata,
  ) => {
    const enqueue = () => localDb.enqueue({
      op: 'upsert', path: note.path, notebook, name: note.name,
      content: note.content, driveId: note.driveId, updatedAt: note.updatedAt,
    });
    const d = driveRef.current;
    if (!d) { await enqueue(); return; }
    try {
      const newId = await d.putFile(note.path, '', note.content, note.driveId);
      await localDb.putNote({ ...note, driveId: newId });
      const metaId = await d.putMetadata(notebook, meta.titles, meta.order, meta.updated, meta.tags, localMetaId);
      const local = await localDb.getMetadata(notebook);
      if (local) await localDb.putMetadata({ ...local, driveMetaId: metaId });
    } catch {
      await enqueue();
    }
  }, []);

  // Queue a Drive file deletion when it can't be performed right now.
  const enqueueDelete = useCallback((path: string, notebook: string, name: string, driveId: string | null) => {
    if (!driveId) return; // never reached Drive — nothing to delete there
    void localDb.enqueue({ op: 'delete', path, notebook, name, driveId, updatedAt: Date.now() });
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
      if (await pullNotebookFromDrive(d, nb.name)) {
        const [freshNotes, freshMeta] = await Promise.all([
          localDb.getNotes(nb.name),
          localDb.getMetadata(nb.name),
        ]);
        setNotes(freshNotes.map(toNoteFile));
        if (freshMeta) setMetadata(toMetaState(freshMeta));
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

      // Delete the Drive folder; queue the whole-notebook delete when offline
      // or on failure (pending per-note work for it becomes moot).
      const queueNotebookDelete = async () => {
        await localDb.removeQueuedForNotebook(nb.name);
        await localDb.enqueue({
          op: 'deleteNotebook', path: `notebook:${nb.name}`,
          notebook: nb.name, name: nb.name, updatedAt: Date.now(),
        });
      };
      const d = driveRef.current;
      if (d) d.deleteNotebook(nb.name).catch(() => { void queueNotebookDelete(); });
      else await queueNotebookDelete();
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

  // ── Tags ─────────────────────────────────────────────────────────────────────

  // Union of every tag across all notebooks — the "existing tags" suggestions.
  const [allTags, setAllTags] = useState<string[]>([]);

  const refreshAllTags = useCallback(async () => {
    const metas = await localDb.getAllMetadata();
    const set = new Set<string>();
    for (const m of metas) {
      for (const list of Object.values(m.tags ?? {})) for (const t of list) set.add(t);
    }
    setAllTags(Array.from(set).sort((a, b) => a.localeCompare(b)));
  }, []);

  useEffect(() => {
    if (dbReady) void refreshAllTags();
  }, [dbReady, refreshAllTags]);

  // ── Note content helpers ─────────────────────────────────────────────────────

  const buildMeta = useCallback((
    prev: NotebookMetadataState,
    fileName: string,
    title: string,
    tags?: string[],
  ): NoteMetadata => {
    const nextTags = { ...prev.tags };
    if (tags !== undefined) {
      if (tags.length) nextTags[fileName] = tags;
      else delete nextTags[fileName];
    }
    return {
      titles: { ...prev.titles, [fileName]: title },
      order: prev.order.includes(fileName) ? prev.order : [...prev.order, fileName],
      updated: { ...prev.updated, [fileName]: Date.now() },
      tags: nextTags,
    };
  }, []);

  const commitMeta = useCallback(async (
    nb: string,
    meta: NoteMetadata,
    currentDriveMetaId: string | null,
  ) => {
    const current = await localDb.getMetadata(nb);
    const next: LocalMeta = {
      notebook: nb,
      titles: meta.titles, order: meta.order, updated: meta.updated, tags: meta.tags,
      driveMetaId: currentDriveMetaId ?? current?.driveMetaId ?? null,
    };
    await localDb.putMetadata(next);
    setMetadata({ ...meta, sha: next.driveMetaId });
    void refreshAllTags();
    return next;
  }, [refreshAllTags]);

  // ── Deletion ─────────────────────────────────────────────────────────────────

  const deleteNote = useCallback(async (note: NoteFile) => {
    if (!selectedNotebook) return;
    const localNote = await localDb.getNote(note.path);
    await localDb.deleteNote(note.path);

    const newTitles = { ...metadata.titles };
    delete newTitles[note.name];
    const newUpdated = { ...metadata.updated };
    delete newUpdated[note.name];
    const newTags = { ...metadata.tags };
    delete newTags[note.name];
    const newOrder = metadata.order.filter(n => n !== note.name);
    const newMeta: NoteMetadata = {
      titles: newTitles, order: newOrder, updated: newUpdated, tags: newTags,
    };

    await commitMeta(selectedNotebook.name, newMeta, metadata.sha);
    setNotes(prev => prev.filter(n => n.name !== note.name));
    notify('Note deleted.', 'success');

    const d = driveRef.current;
    const driveId = localNote?.driveId ?? note.sha;
    if (d && driveId) {
      const nbName = selectedNotebook.name;
      d.deleteFile(note.path, driveId, '').catch(() => {
        // Queue it — otherwise the next Drive pull resurrects the note.
        enqueueDelete(note.path, nbName, note.name, driveId);
      });
      d.putMetadata(nbName, newTitles, newOrder, newUpdated, newTags, metadata.sha)
        .catch(() => {});
    } else {
      enqueueDelete(note.path, selectedNotebook.name, note.name, driveId);
    }
  }, [selectedNotebook, metadata, commitMeta, notify, enqueueDelete]);

  // ── Move note ────────────────────────────────────────────────────────────────

  const moveNote = useCallback(async (note: NoteFile, target: Notebook) => {
    if (!selectedNotebook || target.name === selectedNotebook.name) return;
    const localNote = await localDb.getNote(note.path);
    if (!localNote) return;

    const title = metadata.titles[note.name] || note.name.replace(/\.mdx?$/, '');
    const noteTags = metadata.tags[note.name] ?? [];
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
      tags: {
        ...(targetMeta?.tags ?? {}),
        ...(noteTags.length ? { [note.name]: noteTags } : {}),
      },
      driveMetaId: targetMeta?.driveMetaId ?? null,
    };
    await localDb.putMetadata(tMeta);

    const newTitles = { ...metadata.titles };
    delete newTitles[note.name];
    const newUpdated = { ...metadata.updated };
    delete newUpdated[note.name];
    const newTags = { ...metadata.tags };
    delete newTags[note.name];
    const newOrder = metadata.order.filter(n => n !== note.name);
    await commitMeta(
      selectedNotebook.name,
      { titles: newTitles, order: newOrder, updated: newUpdated, tags: newTags },
      metadata.sha,
    );
    setNotes(prev => prev.filter(n => n.name !== note.name));
    notify(`Moved "${title}" to ${target.name}.`, 'success');

    // Sync to Drive in background (driveUpsert queues the new file when offline)
    const d = driveRef.current;
    const newLocalNote = await localDb.getNote(newPath);
    if (newLocalNote) {
      driveUpsert(newLocalNote, tMeta.driveMetaId, target.name, {
        titles: tMeta.titles, order: tMeta.order, updated: tMeta.updated, tags: tMeta.tags ?? {},
      }).catch(() => {});
    }
    const oldDriveId = localNote.driveId ?? note.sha;
    const srcName = selectedNotebook.name;
    if (d && oldDriveId) {
      d.deleteFile(note.path, oldDriveId, '').catch(() => {
        enqueueDelete(note.path, srcName, note.name, oldDriveId);
      });
    } else {
      enqueueDelete(note.path, srcName, note.name, oldDriveId);
    }
  }, [selectedNotebook, metadata, commitMeta, notify, driveUpsert, enqueueDelete]);

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
      const fileName = editingNote.path.split('/').pop() ?? '';
      const [localNote, freshMeta] = await Promise.all([
        localDb.getNote(editingNote.path),
        selectedNotebook ? localDb.getMetadata(selectedNotebook.name) : Promise.resolve(null),
      ]);
      if (localNote) {
        setEditingNote(prev => prev ? {
          ...prev,
          sha: localNote.driveId,
          content: localNote.content,
          title: freshMeta?.titles?.[fileName] ?? prev.title,
          tags: freshMeta?.tags?.[fileName] ?? prev.tags,
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
        tags: metadata.tags[note.name] ?? [],
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
    note: NoteFile, title: string, content: string, _sha: string | null, tags?: string[],
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

    const newMeta = buildMeta(metadata, note.name, noteTitle, tags);
    const localMeta = await commitMeta(selectedNotebook.name, newMeta, metadata.sha);

    driveUpsert(updatedNote, localMeta.driveMetaId, selectedNotebook.name, newMeta).catch(() => {});
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
      const nbName = selectedNotebook.name;
      d.putMetadata(nbName, meta.titles, newOrder, meta.updated, meta.tags ?? {}, meta.driveMetaId)
        .then(async id => {
          // Re-read before writing back — only record the new Drive file ID,
          // never revert metadata committed during the network round-trip.
          if (!id) return;
          const fresh = await localDb.getMetadata(nbName);
          if (fresh) await localDb.putMetadata({ ...fresh, driveMetaId: id });
        }).catch(() => {});
    }
  }, [selectedNotebook]);

  const createNoteInline = useCallback(async (
    preceding: string[], following: string[], title: string, content: string, tags?: string[],
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

    const newMeta: NoteMetadata = {
      titles: { ...metadata.titles, [fileName]: noteTitle },
      order: [...preceding, fileName, ...following],
      updated: { ...metadata.updated, [fileName]: now },
      tags: tags?.length ? { ...metadata.tags, [fileName]: tags } : metadata.tags,
    };
    const localMeta = await commitMeta(selectedNotebook.name, newMeta, metadata.sha);

    setNotes(prev => prev.some(n => n.name === fileName)
      ? prev : [...prev, toNoteFile(newNote)]);
    notify('Note created.', 'success');
    flashSync();

    driveUpsert(newNote, localMeta.driveMetaId, selectedNotebook.name, newMeta).catch(() => {});
  }, [selectedNotebook, metadata, commitMeta, notify, flashSync, driveUpsert]);

  // ── Full-screen save ──────────────────────────────────────────────────────────

  const saveNote = useCallback(async (title: string, content: string, tags?: string[]) => {
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
        prev ? { ...prev, title, content, tags: tags ?? prev.tags }
             : { path: filePath, sha: null, title, content, tags: tags ?? [] },
      );

      const newMeta = buildMeta(metadata, fileName, noteTitle, tags);
      const localMeta = await commitMeta(selectedNotebook.name, newMeta, metadata.sha);

      setNotes(prev => prev.some(n => n.name === fileName)
        ? prev.map(n => n.name === fileName ? toNoteFile(updatedNote) : n)
        : [...prev, toNoteFile(updatedNote)],
      );

      flashSync();

      // Async Drive sync (non-blocking)
      driveUpsert(updatedNote, localMeta.driveMetaId, selectedNotebook.name, newMeta)
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
    allTags,
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
