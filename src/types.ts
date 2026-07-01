// Central type definitions for the Write app (the Drive-backed notebook editor).
//
// Grouped into two concerns:
//   1. Domain models (notebooks, notes, per-notebook metadata)
//   2. UI / editor lifecycle state (draft → saving → error)

// ── 1. Domain models ─────────────────────────────────────────────────────────

/** A notebook is a Drive subfolder under the root "simple-notebook" folder. */
export interface Notebook {
  name: string;
}

/**
 * A note file (`*.md`/`*.mdx`) inside a notebook folder.
 * `sha` holds the Drive file ID, used for delete and update operations.
 */
export interface NoteFile {
  name: string;
  sha: string | null;
  type: 'file';
  path: string;
}

/**
 * Parsed `_metadata.json` payload: human titles, the user-defined display
 * order, last-updated timestamps (epoch millis), and tag lists, all keyed
 * by file name.
 */
export interface NoteMetadata {
  titles: Record<string, string>;
  order: string[];
  updated: Record<string, number>;
  tags: Record<string, string[]>;
}

/** Metadata plus the Drive file ID of `_metadata.json` (in the `sha` field). */
export interface NotebookMetadataState extends NoteMetadata {
  sha: string | null;
}

/** A note's body together with the Drive file ID required to update it. */
export interface NoteContent {
  content: string;
  sha: string | null;
}

// ── 2. UI / editor lifecycle ─────────────────────────────────────────────────

/** Lifecycle of an editable note: a clean state machine for the UI to render. */
export type NoteLifecycle = 'idle' | 'draft' | 'saving' | 'committed' | 'error';

/** The note currently open in the full-screen editor. */
export interface EditingNote {
  path: string;
  sha: string | null;
  title: string;
  content: string;
  tags: string[];
  /** Bumped to force the editor to re-seed after a remote refresh. */
  _refreshKey?: number;
}

export type SaveModalStep = 'idle' | 'pushing' | 'syncing' | 'done' | 'error';
export type NotebookModalStep = 'idle' | 'creating' | 'syncing' | 'done' | 'error';

export interface SaveModalState {
  open: boolean;
  step: SaveModalStep;
  progress: number;
  error: string | null;
}

export interface NotebookModalState {
  open: boolean;
  step: NotebookModalStep;
  error: string | null;
}

/** Whether a sync poll waits for a file to appear or to disappear. */
export type SyncMode = 'appeared' | 'gone';

/** A transient, user-facing notification (toast). */
export interface AppNotification {
  id: number;
  kind: 'error' | 'success' | 'info';
  message: string;
}
