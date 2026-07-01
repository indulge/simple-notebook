// Notebook workspace page.
//
// Notes are always stored locally in IndexedDB; connecting a Google Drive token
// is optional and enables cross-device sync. The workspace opens immediately
// without requiring any token.

import React, { useEffect, useRef, useState } from 'react';
import Layout from '@theme/Layout';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import EmptyState from '@site/src/components/notebook/EmptyState';
import NewNotebookPanel from '@site/src/components/notebook/NewNotebookPanel';
import NoteEditor from '@site/src/components/notebook/NoteEditor';
import MiniNotebookGrid from '@site/src/components/notebook/MiniNotebookGrid';
import NoteList from '@site/src/components/notebook/NoteList';
import NotebookModal from '@site/src/components/notebook/NotebookModal';
import PublishModal from '@site/src/components/notebook/PublishModal';
import SaveModal from '@site/src/components/notebook/SaveModal';
import Sidebar from '@site/src/components/notebook/Sidebar';
import SyncDock from '@site/src/components/notebook/SyncDock';
import TokenGate from '@site/src/components/notebook/TokenGate';
import { s } from '@site/src/components/notebook/styles';
import { NotificationProvider } from '@site/src/hooks/useNotifications';
import { useNotebook } from '@site/src/hooks/useNotebook';

function Workspace() {
  const [token, setToken] = useState<string | null>(null);
  const [showDriveDialog, setShowDriveDialog] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('gd_token') : null;
    if (saved) setToken(saved);
  }, []);

  const nb = useNotebook(token);

  const quickRequested =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('quick');
  const quickHandled = useRef(false);
  useEffect(() => {
    if (!quickRequested || quickHandled.current) return;
    if (!nb.dbReady) return;
    quickHandled.current = true;
    void nb.quickCapture();
  }, [quickRequested, nb.dbReady, nb]);

  const connectDrive = (t: string) => {
    setToken(t);
    setShowDriveDialog(false);
  };

  const disconnectDrive = () => {
    localStorage.removeItem('gd_token');
    setToken(null);
    setShowDriveDialog(false);
  };

  if (showDriveDialog) {
    return (
      <TokenGate
        onAuthenticated={connectDrive}
        onDismiss={() => setShowDriveDialog(false)}
        onSkip={() => setShowDriveDialog(false)}
      />
    );
  }

  return (
    <div style={s.workspace}>
      {(nb.refreshing || nb.refreshProgress > 0) && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 100,
            backgroundColor: 'var(--ifm-color-emphasis-200)',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${nb.refreshProgress}%`,
              backgroundColor: 'var(--ifm-color-primary)',
              transition: nb.refreshProgress < 100 ? 'width 0.12s ease' : 'width 0.3s ease',
            }}
          />
        </div>
      )}
      <Sidebar
        notebooks={nb.notebooks}
        selected={nb.selectedNotebook}
        onSelect={nb.selectNotebook}
        onNewNotebook={nb.openNewNotebook}
        onDeleteNotebook={nb.deleteNotebook}
        deletingNotebook={nb.deletingNotebook}
        loading={nb.loadingNotebooks}
        onRefresh={nb.refreshAll}
        refreshing={nb.refreshing}
      />
      <main style={s.main}>
        {nb.view === 'new-notebook' && (
          <NewNotebookPanel
            onCreate={nb.createNotebook}
            onCancel={nb.showList}
            saving={nb.notebookModal.open}
          />
        )}
        {nb.view === 'edit' && (
          <ErrorBoundary label="the editor">
            <NoteEditor
              key={
                nb.editingNote
                  ? `${nb.editingNote.path}-${nb.editingNote._refreshKey ?? 0}`
                  : 'new'
              }
              onBack={nb.showList}
              onSave={nb.saveNote}
              draftKey={nb.editingNote?.path ?? `new:${nb.selectedNotebook?.name ?? ''}`}
              onUploadImage={nb.uploadImage}
              notebookName={nb.selectedNotebook?.name ?? ''}
              initialTitle={nb.editingNote?.title ?? ''}
              initialContent={nb.editingNote?.content ?? ''}
              initialTags={nb.editingNote?.tags ?? []}
              allTags={nb.allTags}
              saving={nb.saving}
              conflictBanner={nb.conflictBanner}
              onClearConflict={nb.clearConflict}
            />
          </ErrorBoundary>
        )}
        {nb.view === 'list' && nb.selectedNotebook && (
          <ErrorBoundary label="this notebook">
            <NoteList
              notebook={nb.selectedNotebook}
              notebooks={nb.notebooks}
              notes={nb.notes}
              loading={nb.loadingNotes}
              onDeleteNote={nb.deleteNote}
              onMoveNote={nb.moveNote}
              metadata={nb.metadata}
              allTags={nb.allTags}
              onLoadNote={nb.loadNoteContent}
              onSaveNote={nb.saveNoteContent}
              onReorder={nb.reorderNotes}
              onCreateNote={nb.createNoteInline}
              syncing={nb.syncing}
              syncProgress={nb.syncProgress}
            />
          </ErrorBoundary>
        )}
        {nb.view === 'list' && !nb.selectedNotebook && <EmptyState />}
      </main>
      {nb.saveModal.open && (
        <SaveModal
          step={nb.saveModal.step}
          progress={nb.saveModal.progress}
          error={nb.saveModal.error}
          onClose={nb.closeSaveModal}
        />
      )}
      {nb.notebookModal.open && (
        <NotebookModal
          step={nb.notebookModal.step}
          error={nb.notebookModal.error}
          onClose={nb.closeNotebookModal}
        />
      )}
      {nb.selectedNotebook && (
        <MiniNotebookGrid
          notebookName={nb.selectedNotebook.name}
          notes={nb.notes}
          metadata={nb.metadata}
          onOpenNote={nb.openNote}
        />
      )}
      <SyncDock
        saving={nb.saving}
        syncing={nb.syncing}
        refreshing={nb.refreshing}
      />
      {showPublishDialog && (
        <PublishModal
          notebooks={nb.notebooks}
          driveToken={token}
          onClose={() => setShowPublishDialog(false)}
        />
      )}
      <button
        onClick={() => setShowDriveDialog(true)}
        style={{
          ...s.forgetBtn,
          backgroundColor: token ? 'var(--ifm-color-primary-lightest)' : undefined,
        }}
        title={token ? 'Drive connected — click to manage' : 'Connect Google Drive'}
      >
        {token ? '☁' : '🔗'}
      </button>
      <button
        onClick={() => setShowPublishDialog(true)}
        style={{ ...s.forgetBtn, right: 57 }}
        title="Publish notebooks to the reading site"
      >
        ⇪
      </button>
      {token && (
        <button
          onClick={disconnectDrive}
          style={{ ...s.forgetBtn, right: 98 }}
          title="Disconnect Drive"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default function NotebookPage() {
  return (
    <Layout title="Notebook" description="Write notes">
      <NotificationProvider>
        <ErrorBoundary label="the notebook">
          <Workspace />
        </ErrorBoundary>
      </NotificationProvider>
    </Layout>
  );
}
