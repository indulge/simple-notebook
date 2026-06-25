# Sachin Notebook — Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          GitHub Repository (indulge/simple-notebook)                │
│                                                                                     │
│   docs/                                  .github/workflows/deploy.yml               │
│   ├── <notebook>/                        ┌────────────────────────┐                 │
│   │   ├── note.md                        │  push to main          │                 │
│   │   ├── _metadata.json                 │    → npm run build     │                 │
│   │   └── _category_.json               │    → GitHub Pages      │                 │
│   └── ...                               └────────────────────────┘                 │
└──────────────────────────┬──────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          │   GitHub Contents API           │
          │   GET / PUT / DELETE            │
          │   (Base64 content, SHA-based)   │
          └────────────────┬────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────────────────────┐
│                          Browser (React 19 + Docusaurus 3)                          │
│                                                                                     │
│  Route: /simple-notebook/                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  src/pages/homepage.js  (home page — links to /read and /write)             │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│  Route: /simple-notebook/read/*    ← Static docs generated at build time           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  Docusaurus Docs                                                             │   │
│  │  sidebars.js ─── readNotebooksFromDisk(docs/)                               │   │
│  │                  (build-time, Node.js)                                       │   │
│  │                  └── notebooksFs.js ── notes.js (shared utils)              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│  Route: /simple-notebook/write     ← Interactive SPA (client-side only)            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  src/pages/write.tsx                                                         │   │
│  │  State: pat (GitHub token), showTokenDialog                                  │   │
│  │                                                                               │   │
│  │   ┌─── TokenGate.tsx ───────────────────────────────────────────────────┐   │   │
│  │   │   (PAT input/validation — shown when no token)                       │   │   │
│  │   └─────────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                               │   │
│  │   ┌─── Workspace ────────────────────────────────────────────────────────┐  │   │
│  │   │                                                                        │  │   │
│  │   │  ┌──── useGitHubNotebook (Core Data Layer) ───────────────────────┐  │  │   │
│  │   │  │  State: notebooks, notes, metadata, editingNote, view,         │  │  │   │
│  │   │  │         saving, syncing, deployStatus, saveModal, etc.         │  │  │   │
│  │   │  │                                                                  │  │  │   │
│  │   │  │  ┌───────────────────────────────────────────────────────┐     │  │  │   │
│  │   │  │  │  GitHubNotebookClient  (src/services/github.ts)        │     │  │  │   │
│  │   │  │  │  ┌─────────────────────────────────────────────────┐  │     │  │  │   │
│  │   │  │  │  │  listNotebooks()   getNote()   putFile()         │  │     │  │  │   │
│  │   │  │  │  │  listNotes()       putMetadata() deleteFile()    │  │     │  │  │   │
│  │   │  │  │  │  getMetadata()     getLatestDeployRun()          │  │     │  │  │   │
│  │   │  │  │  └─────────────────────────────────────────────────┘  │     │  │  │   │
│  │   │  │  └───────────────────────────────────────────────────────┘     │  │  │   │
│  │   │  │                                                                  │  │  │   │
│  │   │  │  Support hooks:                                                  │  │  │   │
│  │   │  │  ├── useSaveLifecycle    (idle→saving→committed→error)          │  │  │   │
│  │   │  │  └── useNotifications   (toast system)                          │  │  │   │
│  │   │  └───────────────────────────────────────────────────────────────  │  │  │   │
│  │   │                          │ props + callbacks                         │  │  │   │
│  │   │  ┌────────────────────── ▼ ──────────────────────────────────────┐  │  │   │
│  │   │  │                    UI Components                               │  │  │   │
│  │   │  │                                                                 │  │  │   │
│  │   │  │  ┌─── Sidebar.tsx ──────────────────────────────────────────┐ │  │  │   │
│  │   │  │  │   Notebook list, select, create, delete                   │ │  │  │   │
│  │   │  │  └──────────────────────────────────────────────────────────┘ │  │  │   │
│  │   │  │                                                                 │  │  │   │
│  │   │  │  ┌─── Main area (switches on view state) ────────────────────┐ │  │  │   │
│  │   │  │  │                                                            │ │  │  │   │
│  │   │  │  │  view='list'  → NoteList.tsx                              │ │  │  │   │
│  │   │  │  │                  ├── ExpandableNote.tsx (per note)        │ │  │  │   │
│  │   │  │  │                  │   (collapsed: title+time;              │ │  │  │   │
│  │   │  │  │                  │    expanded: inline edit+save)         │ │  │  │   │
│  │   │  │  │                  ├── DraftNote.tsx (insert between notes) │ │  │  │   │
│  │   │  │  │                  └── drag-to-reorder (useNoteListInteract)│ │  │  │   │
│  │   │  │  │                                                            │ │  │  │   │
│  │   │  │  │  view='edit'  → NoteEditor.tsx                            │ │  │  │   │
│  │   │  │  │                  ├── edit / split / preview modes         │ │  │  │   │
│  │   │  │  │                  └── MarkdownPreview.tsx                  │ │  │  │   │
│  │   │  │  │                                                            │ │  │  │   │
│  │   │  │  │  view='new-notebook' → NewNotebookPanel.tsx               │ │  │  │   │
│  │   │  │  └────────────────────────────────────────────────────────── ┘ │  │  │   │
│  │   │  │                                                                 │  │  │   │
│  │   │  │  ┌─── Overlays ──────────────────────────────────────────────┐ │  │  │   │
│  │   │  │  │  SaveModal.tsx      (push/sync error details)             │ │  │  │   │
│  │   │  │  │  NotebookModal.tsx  (creation progress)                   │ │  │  │   │
│  │   │  │  │  MiniNotebookGrid   (small tile preview)                  │ │  │  │   │
│  │   │  │  └──────────────────────────────────────────────────────────┘ │  │  │   │
│  │   │  │                                                                 │  │  │   │
│  │   │  │  ┌─── SyncDock.tsx ──────────────────────────────────────────┐ │  │  │   │
│  │   │  │  │  (bottom-right: save progress, deploy status)             │ │  │  │   │
│  │   │  │  └──────────────────────────────────────────────────────────┘ │  │  │   │
│  │   │  └─────────────────────────────────────────────────────────────── ┘  │  │   │
│  │   └────────────────────────────────────────────────────────────────────── ┘  │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Save a Note

```
User types in NoteEditor / ExpandableNote
        │
        │ onSave(title, content)
        ▼
useGitHubNotebook.saveNote()
        │
        ├─ [Phase 1 — blocks UI]
        │   GitHubNotebookClient.putFile(path, content, sha)
        │          │
        │          ├── 200 OK  → update EditingNote.sha
        │          └── 409     → reload latest SHA
        │                         show conflict banner
        │                         preserve user edits
        │
        ├─ [Metadata — non-blocking]
        │   GitHubNotebookClient.putMetadata(_metadata.json)
        │   (failure silently resolves, never throws)
        │
        └─ [Phase 2 — background]
            startSyncPoll(filename, notebook, 'appeared')
               │  Poll listNotes() every 2s, up to 8× (16s max)
               │  Progress: 0% → 85% animated, jump to 100%
               ▼
            watchDeploy()
               │  Poll GitHub Actions API every 10s, cap 10min
               ▼
            SyncDock shows: Saving → Syncing → Deploying → Live
```

---

## Data Flow: Load the Write App

```
Browser opens /write
        │
        ├─ No token in localStorage?
        │   └─ Show TokenGate → user enters PAT
        │       └─ verify() → GitHub /user endpoint
        │
        ├─ Token present → new GitHubNotebookClient(token)
        │
        ├─ fetchNotebooks() → listNotebooks()
        │   GET /repos/{owner}/{repo}/contents/docs
        │   └─ Filter dirs with _category_.json
        │
        └─ selectNotebook(notebook)
            ├─ fetchNotes() → listNotes()
            └─ fetchMetadata() → getMetadata()
                └─ parseMetadata() → { titles, order, updated }
                    └─ orderNotes() → sorted by metadata order
```

---

## Shared Utilities (notes.js — used at build time AND runtime)

```
┌─────────────────────────────────────────────────────────┐
│  src/lib/notes.js   (pure JS, no browser/Node APIs)     │
│                                                          │
│  Constants:  OWNER, REPO, BRANCH, DOCS_PATH, API        │
│                                                          │
│  Storage:    draftStorageKey()   → localStorage key     │
│  Encoding:   b64Encode()         → UTF-8 → Base64       │
│              b64Decode()         → Base64 → UTF-8       │
│  Slugs:      slugify()           → kebab-case           │
│                                                          │
│  Metadata:   parseMetadata()     → unify legacy+new fmt │
│              serializeMetadata() → { titles,order,upd } │
│              noteUpdatedAt()     → from filename/meta   │
│              formatTimestamp()   → human-readable       │
│                                                          │
│  Ordering:   orderNotes()        → sort by meta order   │
│              moveToIndex()       → drag-reorder helper  │
└──────────────────────────────────────────────────────────┘
          ▲                         ▲
          │ (browser)               │ (Node.js, build time)
   useGitHubNotebook           sidebars.js
   GitHubNotebookClient        notebooksFs.js
                                notebook-snapshot plugin
```

---

## State Machine: NoteLifecycle

```
          ┌────────────────────────────────────┐
          │                                    │
    ┌─────▼──────┐   begin()   ┌──────────┐   │
    │    idle    │────────────►│  saving  │   │
    └────────────┘             └─────┬────┘   │
          ▲                          │        │
          │                    succeed()      │
          │                          │        │
    1.5s reset                ┌──────▼──────┐ │
          │                   │  committed  │ │
          └───────────────────┴─────────────┘ │
                                    │         │
                               fail(err)      │
                                    │         │
                             ┌──────▼──────┐  │
                             │    error    │──┘
                             └─────────────┘
                               begin() restarts
```

---

## Build Pipeline (Static Read Side)

```
git push main
      │
      ▼
GitHub Actions: deploy.yml
      │
      ├─ npm ci
      │
      ├─ npm run build  (Docusaurus build)
      │   │
      │   ├─ sidebars.js
      │   │   └── readNotebooksFromDisk('docs/')   ← Node.js at build time
      │   │       ├── reads _category_.json        ← sidebar label + position
      │   │       ├── reads _metadata.json         ← note titles, order
      │   │       └── returns Notebook[] for Docusaurus categories
      │   │
      │   ├─ notebook-snapshot plugin
      │   │   └── generates metadata snapshots
      │   │
      │   ├─ Docusaurus renders docs/ → /read/* pages
      │   ├─ Docusaurus renders write.tsx → /write (SPA shell)
      │   └─ Output: build/
      │
      └─ Deploy build/ → GitHub Pages
             └─ Live at: https://indulge.github.io/simple-notebook/
```

---

## Layer Map

```
┌───────────────────────────────────────────────────────────────┐
│  External                                                      │
│  GitHub Contents API  ·  GitHub Actions API  ·  localStorage  │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│  Service Layer       src/services/github.ts                    │
│  GitHubNotebookClient — all network I/O, no logic leaks up     │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│  Orchestration Layer   src/hooks/useGitHubNotebook.ts          │
│  All app state + operations; drives service layer              │
│  Support: useSaveLifecycle · useNotifications                  │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│  UI Layer   src/components/notebook/  +  src/pages/write.tsx   │
│  Presentational; no direct network calls; route events up      │
│  Support: useNoteListInteractions · styles.ts                  │
└───────────────────────────────────────────────────────────────┘

Shared across all layers (build + runtime):
  src/lib/notes.js      — pure utilities, no side-effects
  src/types.ts          — TypeScript contracts
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Thick hook, thin components | All business logic testable without rendering |
| SHA-based optimistic concurrency | GitHub Contents API requires SHA for writes; 409 → conflict banner |
| Non-blocking metadata writes | Metadata failure must never block the note save |
| `notes.js` is plain JS (not TS) | Shared between browser and Node.js build scripts |
| `_metadata.json` per notebook | Syncs human titles + order between write and read sides |
| Draft in localStorage | Tab crashes don't lose unsaved work |
| Toast over modal for errors | Non-blocking async errors suit background sync failures |
| Polling sync (not webhooks) | GitHub Contents API is pull-based; no webhook infrastructure needed |
