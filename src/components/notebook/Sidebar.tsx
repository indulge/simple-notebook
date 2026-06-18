import React, { useState } from 'react';
import type { Notebook } from '@site/src/types';
import { s } from './styles';

interface Props {
  notebooks: Notebook[];
  selected: Notebook | null;
  onSelect: (nb: Notebook) => void;
  onNewNotebook: () => void;
  onDeleteNotebook: (nb: Notebook) => void;
  deletingNotebook: string | null;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}

function Sidebar({
  notebooks,
  selected,
  onSelect,
  onNewNotebook,
  onDeleteNotebook,
  deletingNotebook,
  loading,
  onRefresh,
  refreshing,
}: Props) {
  // Name of the notebook with the inline "Delete? Yes/No" confirm open.
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <aside style={s.sidebar}>
      <div style={s.sidebarHeader}>
        <span>My Notebooks</span>
        <button
          onClick={onRefresh}
          disabled={loading || refreshing}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            padding: '0 2px',
            opacity: loading || refreshing ? 0.4 : 0.7,
            lineHeight: 1,
          }}
          title="Refresh all"
        >
          {refreshing ? '⟳' : '↻'}
        </button>
      </div>
      <div style={s.notebookList}>
        {loading && <div style={s.hint}>Loading…</div>}
        {!loading && notebooks.length === 0 && (
          <div style={s.hint}>
            No notebooks yet.
            <br />
            Create one below.
          </div>
        )}
        {notebooks.map((nb) => {
          const isDeleting = deletingNotebook === nb.name;
          return (
            <div
              key={nb.name}
              className="notebook-item-row"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(nb)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(nb);
              }}
              style={{
                ...s.notebookItem,
                ...(selected?.name === nb.name ? s.notebookItemActive : {}),
                ...(isDeleting ? { opacity: 0.5 } : {}),
              }}
            >
              <span style={s.notebookIcon}>📓</span>
              <span style={s.notebookLabel}>{nb.name}</span>
              <span style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                {isDeleting ? (
                  <span style={{ fontSize: 11, color: 'var(--ifm-color-emphasis-500)' }}>
                    Deleting…
                  </span>
                ) : confirming === nb.name ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <button
                      onClick={() => {
                        setConfirming(null);
                        onDeleteNotebook(nb);
                      }}
                      style={{ ...s.btn, ...s.btnDanger, padding: '2px 7px', fontSize: 11 }}
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      style={{ ...s.btn, ...s.btnGhost, padding: '2px 7px', fontSize: 11 }}
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    className="note-delete-btn"
                    onClick={() => setConfirming(nb.name)}
                    style={s.deleteBtn}
                    title="Delete notebook (deletes all its notes)"
                  >
                    🗑
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div style={s.sidebarFooter}>
        <button onClick={onNewNotebook} style={{ ...s.btn, ...s.btnOutline, width: '100%' }}>
          + New Notebook
        </button>
      </div>
    </aside>
  );
}

export default React.memo(Sidebar);
