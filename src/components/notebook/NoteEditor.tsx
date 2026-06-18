// Full-screen single-note editor with edit/split/preview modes, dirty tracking,
// Ctrl/Cmd-S save, image paste/drop upload, a localStorage draft safety net,
// and inline merge-conflict recovery. Pure UI — the actual save (and its sync
// orchestration) is owned by the parent via `onSave`.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { draftStorageKey } from '@site/src/lib/notes';
import { useNotifications } from '@site/src/hooks/useNotifications';
import MarkdownPreview from './MarkdownPreview';
import { s } from './styles';

type EditorMode = 'edit' | 'split' | 'preview';

interface Props {
  onBack: () => void;
  onSave: (title: string, content: string) => void;
  /** Stable identity for the localStorage draft (the note's repo path). */
  draftKey: string;
  /** Uploads raw image bytes to the repo; resolves to the markdown URL. */
  onUploadImage?: (file: File) => Promise<string>;
  notebookName?: string;
  initialTitle?: string;
  initialContent?: string;
  saving: boolean;
  conflictBanner: boolean;
  onClearConflict: () => void;
}

interface StoredDraft {
  title: string;
  content: string;
  ts: number;
}

function readDraft(key: string): StoredDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    return typeof parsed?.content === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export default function NoteEditor({
  onBack,
  onSave,
  draftKey,
  onUploadImage,
  notebookName = '',
  initialTitle = '',
  initialContent = '',
  saving,
  conflictBanner,
  onClearConflict,
}: Props) {
  const { notify } = useNotifications();
  const storageKey = draftStorageKey(draftKey);

  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<EditorMode>('edit');
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A draft left behind by a crash/closed tab. Offered once, on mount.
  const [recoveredDraft, setRecoveredDraft] = useState<StoredDraft | null>(() => {
    const draft = readDraft(storageKey);
    return draft && (draft.title !== initialTitle || draft.content !== initialContent)
      ? draft
      : null;
  });

  // Baseline = last persisted state. Resyncs when the parent pushes new saved
  // values (after a successful save), which clears the "unsaved" indicator.
  const [baseTitle, setBaseTitle] = useState(initialTitle);
  const [baseContent, setBaseContent] = useState(initialContent);
  useEffect(() => {
    setBaseTitle(initialTitle);
    setBaseContent(initialContent);
  }, [initialTitle, initialContent]);

  const isDirty = title !== baseTitle || content !== baseContent;

  // Draft safety net: persist unsaved work (debounced), clear once clean.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const timer = setTimeout(() => {
      try {
        if (isDirty) {
          localStorage.setItem(storageKey, JSON.stringify({ title, content, ts: Date.now() }));
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch {
        /* quota/private mode — the draft net is best-effort */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [title, content, isDirty, storageKey]);

  // Block accidental tab close / navigation while there is unsaved work.
  useEffect(() => {
    if (!isDirty) return undefined;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  useEffect(() => {
    if (mode !== 'preview' && textareaRef.current) textareaRef.current.focus();
  }, [mode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!saving && isDirty) onSave(title, content);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [title, content, saving, isDirty, onSave]);

  const clearStoredDraft = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  const handleExit = () => {
    if (isDirty) setDiscardConfirm(true);
    else onBack();
  };

  const handleDiscard = () => {
    clearStoredDraft();
    onBack();
  };

  // ── image paste / drop ──────────────────────────────────────────────────────

  const insertAtCursor = useCallback((snippet: string) => {
    const ta = textareaRef.current;
    setContent((prev) => {
      if (!ta) return `${prev}\n${snippet}`;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? start;
      return prev.slice(0, start) + snippet + prev.slice(end);
    });
  }, []);

  const uploadAndInsert = useCallback(
    async (file: File) => {
      if (!onUploadImage) return;
      const placeholder = `![Uploading ${file.name}…](uploading-${Date.now()})`;
      insertAtCursor(`\n${placeholder}\n`);
      try {
        const url = await onUploadImage(file);
        const alt = file.name.replace(/\.[^.]*$/, '') || 'image';
        setContent((prev) => prev.replace(placeholder, `![${alt}](${url})`));
        notify('Image uploaded.', 'success');
      } catch (e) {
        setContent((prev) => prev.replace(`\n${placeholder}\n`, '').replace(placeholder, ''));
        notify(e instanceof Error ? e.message : 'Image upload failed.', 'error');
      }
    },
    [onUploadImage, insertAtCursor, notify],
  );

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!onUploadImage) return;
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void uploadAndInsert(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!onUploadImage) return;
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    void uploadAndInsert(file);
  };

  // ── render ──────────────────────────────────────────────────────────────────

  const editorPane = (
    <textarea
      ref={textareaRef}
      value={content}
      onChange={(e) => setContent(e.target.value)}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(e) => {
        if (onUploadImage && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      placeholder="Write your note in Markdown… (paste or drop images)"
      style={s.textarea}
    />
  );

  const previewPane = (
    <MarkdownPreview
      title={title}
      content={content}
      headingLevel="h1"
      wrapperStyle={s.markdownPreview}
    />
  );

  return (
    <div style={s.panel}>
      <div style={s.panelHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <button onClick={handleExit} style={{ ...s.btn, ...s.btnGhost, flexShrink: 0 }}>
            ← Notes
          </button>
          <div style={s.breadcrumb}>
            {notebookName && (
              <>
                <span style={s.crumbMuted}>{notebookName}</span>
                <span style={s.crumbSep}>›</span>
              </>
            )}
            <span style={s.crumbCurrent}>{title.trim() || 'Untitled'}</span>
            {isDirty && (
              <span style={s.unsavedBadge}>
                <span style={s.unsavedDot} />
                unsaved
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {discardConfirm ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--ifm-color-emphasis-600)' }}>
                Discard unsaved changes?
              </span>
              <button
                onClick={handleDiscard}
                style={{ ...s.btn, ...s.btnDanger, padding: '3px 10px', fontSize: 12 }}
              >
                Discard
              </button>
              <button
                onClick={() => setDiscardConfirm(false)}
                style={{ ...s.btn, ...s.btnGhost, padding: '3px 10px', fontSize: 12 }}
              >
                Keep editing
              </button>
            </span>
          ) : (
            <>
              <div style={s.segmented}>
                <button
                  onClick={() => setMode('edit')}
                  style={{ ...s.segment, ...(mode === 'edit' ? s.segmentActive : {}) }}
                >
                  ✎ Edit
                </button>
                <button
                  onClick={() => setMode('split')}
                  style={{ ...s.segment, ...(mode === 'split' ? s.segmentActive : {}) }}
                >
                  ⬓ Split
                </button>
                <button
                  onClick={() => setMode('preview')}
                  style={{ ...s.segment, ...(mode === 'preview' ? s.segmentActive : {}) }}
                >
                  👁 Preview
                </button>
              </div>
              <span style={s.btnSeparator} />
              <button
                onClick={() => onSave(title, content)}
                disabled={saving || !isDirty}
                style={{ ...s.btn, ...(isDirty ? s.btnPrimary : s.btnSaved) }}
              >
                {saving ? 'Saving…' : isDirty ? 'Save Note' : '✓ Saved'}
              </button>
            </>
          )}
        </div>
      </div>
      <div style={s.editorBody}>
        {recoveredDraft && (
          <div style={s.conflictBanner}>
            <span>
              📝 An unsaved draft of this note was found from a previous session
              {recoveredDraft.ts ? ` (${new Date(recoveredDraft.ts).toLocaleString()})` : ''}.
            </span>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                onClick={() => {
                  setTitle(recoveredDraft.title || title);
                  setContent(recoveredDraft.content);
                  setRecoveredDraft(null);
                }}
                style={{ ...s.btn, ...s.btnPrimary, fontSize: 12, padding: '4px 10px' }}
              >
                Restore draft
              </button>
              <button
                onClick={() => {
                  clearStoredDraft();
                  setRecoveredDraft(null);
                }}
                style={{ ...s.btn, ...s.btnGhost, fontSize: 12, padding: '4px 10px' }}
              >
                Discard draft
              </button>
            </div>
          </div>
        )}
        {conflictBanner && (
          <div style={s.conflictBanner}>
            <span>
              ⚠️ Merge conflict detected. The file was updated remotely. The latest SHA has been
              loaded and your edits are preserved — review and save again.
            </span>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                onClick={() => onSave(title, content)}
                style={{ ...s.btn, ...s.btnPrimary, fontSize: 12, padding: '4px 10px' }}
              >
                Retry Save
              </button>
              <button
                onClick={onClearConflict}
                style={{ ...s.btn, ...s.btnGhost, fontSize: 12, padding: '4px 10px' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {mode === 'preview' ? (
          previewPane
        ) : (
          <>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Note title"
              style={{ ...s.input, ...s.titleInput }}
            />
            {mode === 'split' ? (
              <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>{editorPane}</div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {previewPane}
                </div>
              </div>
            ) : (
              editorPane
            )}
          </>
        )}
      </div>
    </div>
  );
}
