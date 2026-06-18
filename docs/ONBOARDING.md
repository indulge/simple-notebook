# Sachin's Notebook — Onboarding Guide

## Project Overview

**sachin-notebook** is a personal notes, tutorials, and references site — mostly covering AI, tooling, and software engineering. It is built with **Docusaurus 3** (React 19) and deployed to **GitHub Pages** via GitHub Actions.

What makes it unusual: it is not just a static site. It includes a **git-backed notebook workspace** at `/write` where notes are read and written directly through the **GitHub Contents API** — every save is a real GitHub commit that triggers an automatic site rebuild and redeploy.

**Languages:** TypeScript, JavaScript, CSS, Markdown, YAML  
**Frameworks:** Docusaurus 3.10.1, React 19, GitHub Actions  
**Live site:** `https://indulge.github.io/sachin-notebook/`  
**Local dev:** `npm install && npm start` → `http://localhost:3000/sachin-notebook/`

---

## Architecture Layers

The project has 8 distinct layers:

| Layer | Files | What it contains |
|---|---|---|
| **UI Layer** | 20 | All React components in `src/components/notebook/` and `src/pages/` — the editor, note list, sidebar, modals, markdown preview, and global CSS |
| **Hooks Layer** | 4 | Custom React hooks in `src/hooks/` — GitHub API orchestration, notification context, note-list interaction state, save lifecycle state machine |
| **Service Layer** | 1 | `src/services/github.ts` — the single authenticated GitHub Contents API client |
| **Utility & Types Layer** | 5 | `src/lib/` shared helpers + `src/types.ts` central type definitions, usable in both browser and Node.js build contexts |
| **Build & Configuration Layer** | 7 | `docusaurus.config.js`, `sidebars.js`, `plugins/notebook-snapshot.js`, `package.json`, `tsconfig.json` |
| **Content Layer** | 11 | `docs/` — published Markdown notes (AI notes, Claude workshops) with Docusaurus category/metadata configs |
| **Documentation Layer** | 5 | `README.md`, `CLAUDE.md`, `arch.md`, `build-git-backed-notebook.md`, `changelog.md` |
| **CI/CD Layer** | 3 | `.github/workflows/deploy.yml` — builds and deploys on every push to `main` |

---

## Key Concepts

**Dual runtime model:** The project operates in two completely different modes:
- **Build time (Node.js):** `notebooksFs.js` reads the `docs/` directory from disk. The `notebook-snapshot` plugin exposes this data to Docusaurus for SSR. `sidebars.js` dynamically builds the sidebar from notebook metadata.
- **Browser runtime:** `useGitHubNotebook` reads and writes notes via the GitHub Contents API. Users authenticate with a GitHub Personal Access Token stored in localStorage.

**Save = commit:** When a user saves a note in the workspace, the browser calls the GitHub Contents API to write a `.md` file. This commit triggers the GitHub Actions deploy workflow — meaning a note save results in a full site rebuild and redeploy within minutes.

**Type-first design:** `src/types.ts` is the vocabulary shared by every layer — defining GitHub API response shapes, domain models (`Notebook`, `Note`, metadata), and UI lifecycle state types. Read it first to understand what data flows through the system.

**Shared utility foundation:** `src/lib/notes.js` (with its TypeScript declaration `notes.d.ts`) is imported by every major module. It holds the GitHub repo constants and pure helpers for slugification, base64 encoding, metadata serialization, and note ordering. Zero UI dependencies — usable in both browser and build contexts.

**Inline styles pattern:** All notebook component styles live in a single `src/components/notebook/styles.ts` file exported as an `s` object. Every component imports `{ s }` and uses `s.styleName` for inline styles — there are no per-component CSS files in the notebook workspace.

---

## Guided Tour

Follow these 14 steps to build a complete mental model of the project:

1. **Project Overview** → `README.md`  
   Start here. The README explains the dual nature of the project — a static docs site on the outside, a git-backed notebook workspace on the inside.

2. **Architecture & Design Decisions** → `arch.md`  
   Read this before any code. It maps the system: data flow sequences, note lifecycle state machine, build pipeline, and layer map.

3. **Site Configuration** → `docusaurus.config.js`, `src/css/custom.css`  
   The Docusaurus root — declares the site URL, base path, navbar, plugins, and theme. The GitHub Actions workflow triggers against this file.

4. **Domain Types** → `src/types.ts`  
   The vocabulary of the system. Read types first to understand what data flows before seeing how it moves.

5. **Shared Utility Library** → `src/lib/notes.js`, `src/lib/notes.d.ts`  
   The most-imported file in the project. GitHub repo constants and pure helpers usable in both browser and Node.js build contexts.

6. **GitHub API Service** → `src/services/github.ts`  
   Single point of contact with the GitHub Contents API. `GitHubNotebookClient` maps directly to API operations — list, read, write, delete, and poll deploy status.

7. **Central Notebook Hook** → `src/hooks/useGitHubNotebook.ts`  
   The nerve center. Wires `GitHubNotebookClient`, utility helpers, and notifications into a single hook managing the entire notebook lifecycle. Every piece of mutable state lives here.

8. **Workspace Entry Point** → `src/pages/write.tsx`, `src/components/ErrorBoundary.tsx`, `src/components/notebook/TokenGate.tsx`  
   The composition root. Imports all 13 sub-components, manages the GitHub PAT token, and decides whether to render `TokenGate` or the full workspace.

9. **Note List & Interaction State** → `src/components/notebook/NoteList.tsx`, `src/hooks/useNoteListInteractions.ts`  
   The primary notebook UI — drag-and-drop ordering, draft creation, deletion dialogs. Complexity tamed by a dedicated `useReducer`-based hook.

10. **Note Editor & Save Lifecycle** → `src/components/notebook/NoteEditor.tsx`, `src/components/notebook/DraftNote.tsx`, `src/hooks/useSaveLifecycle.ts`  
    Full markdown editing with split view modes, draft recovery from localStorage, and image upload. `useSaveLifecycle` implements the idle → saving → saved → error state machine.

11. **Sidebar, Sync Dock & Modals** → `Sidebar.tsx`, `SyncDock.tsx`, `SaveModal.tsx`, `NotebookModal.tsx`  
    The collaborative shell: notebook navigation, real-time save/sync/deploy status, and progress overlays during the async commit-and-deploy cycle.

12. **Build Pipeline & Snapshot Plugin** → `plugins/notebook-snapshot.js`, `src/lib/notebooksFs.js`, `sidebars.js`  
    The build-time path. The plugin reads notebooks from disk at build time and exposes them as Docusaurus global data. `sidebars.js` dynamically generates the sidebar from the same data.

13. **Homepage & Content Layer** → `src/pages/homepage.js`, `docs/ai-notes/_category_.json`  
    The public face. Merges build-time snapshot with live GitHub API data and renders a searchable notebook grid.

14. **CI/CD & Deployment** → `.github/workflows/deploy.yml`, `static/.nojekyll`  
    Every push to `main` builds and deploys the Docusaurus site to GitHub Pages. A note save from the workspace triggers this same workflow.

---

## File Map

### UI Layer (`src/components/`, `src/pages/`, `src/css/`)

| File | Role |
|---|---|
| `src/pages/write.tsx` | Main workspace page — composition root for all notebook components |
| `src/pages/homepage.js` | Public home page — merges build-time snapshot with live GitHub data |
| `src/pages/index.js` | Root redirect to `/homepage` |
| `src/components/notebook/NoteList.tsx` | Primary note list UI with drag-and-drop and lifecycle states |
| `src/components/notebook/NoteEditor.tsx` | Full markdown editor with draft recovery and image upload |
| `src/components/notebook/ExpandableNote.tsx` | Single note card with expand/collapse, edit, drag-and-drop |
| `src/components/notebook/DraftNote.tsx` | New note composition form |
| `src/components/notebook/MarkdownPreview.tsx` | Reusable markdown renderer (react-markdown + GFM) |
| `src/components/notebook/Sidebar.tsx` | Notebook navigation with creation and deletion |
| `src/components/notebook/SyncDock.tsx` | Real-time save/sync/deploy status badges |
| `src/components/notebook/TokenGate.tsx` | GitHub PAT entry and validation |
| `src/components/notebook/MiniNotebookGrid.tsx` | Compact note card grid with popup |
| `src/components/notebook/NotebookModal.tsx` | Notebook creation progress overlay |
| `src/components/notebook/SaveModal.tsx` | Save/sync/deploy progress overlay |
| `src/components/notebook/EmptyState.tsx` | Placeholder when no notebook selected |
| `src/components/notebook/NewNotebookPanel.tsx` | New notebook form |
| `src/components/notebook/styles.ts` | Centralized inline styles for all notebook components (exports `s`) |
| `src/components/ErrorBoundary.tsx` | Error boundary wrapping the workspace |
| `src/css/custom.css` | Global Docusaurus theme overrides (color tokens, typography) |
| `src/pages/index.module.css` | Scoped CSS for the homepage |

### Hooks Layer (`src/hooks/`)

| File | Role |
|---|---|
| `src/hooks/useGitHubNotebook.ts` | **Central hook** — all notebook state and GitHub API operations |
| `src/hooks/useNoteListInteractions.ts` | Note list UI state machine (expand, drag, delete, draft) |
| `src/hooks/useSaveLifecycle.ts` | Save state machine (idle → saving → saved → error) |
| `src/hooks/useNotifications.tsx` | Toast notification context, provider, and hook |

### Service Layer (`src/services/`)

| File | Role |
|---|---|
| `src/services/github.ts` | `GitHubNotebookClient` — all GitHub Contents API operations |

### Utility & Types Layer (`src/lib/`, `src/types.ts`)

| File | Role |
|---|---|
| `src/types.ts` | Central TypeScript types — domain models, API shapes, lifecycle states |
| `src/lib/notes.js` | Shared utilities — slugify, base64, metadata serialization, ordering |
| `src/lib/notes.d.ts` | TypeScript declarations for `notes.js` |
| `src/lib/notebooksFs.js` | Build-time: walks `docs/` to produce sorted notebook list |
| `src/docusaurus-env.d.ts` | Ambient type declarations for Docusaurus module aliases |

### Build & Configuration Layer

| File | Role |
|---|---|
| `docusaurus.config.js` | Docusaurus root config — URL, navbar, plugins, theme |
| `sidebars.js` | Dynamic sidebar built from notebook metadata |
| `plugins/notebook-snapshot.js` | Docusaurus plugin — reads notebooks at build time for SSR |
| `package.json` | Dependencies and npm scripts |
| `tsconfig.json` | TypeScript compiler config |
| `static/.nojekyll` | Prevents GitHub Pages from using Jekyll |

### Content Layer (`docs/`)

| File | Role |
|---|---|
| `docs/claude-notes/claude-workshop-{1-4}.md` | 4-part Claude Code workshop series (810–1062 lines each) |
| `docs/ai-notes/untitled-1780990513692.md` | Comprehensive Claude Code extension points tutorial (810 lines) |
| `docs/ai-notes/ai-concept-tracker-*.md` | Personal AI concepts reference tracker |
| `docs/*/`_category_.json | Docusaurus sidebar category configs |
| `docs/*/`_metadata.json | Custom metadata for display titles and ordering |

### CI/CD Layer

| File | Role |
|---|---|
| `.github/workflows/deploy.yml` | Build + deploy to GitHub Pages on push to `main` |

### Documentation Layer

| File | Role |
|---|---|
| `arch.md` | Full architecture with data flows and state machine diagrams |
| `build-git-backed-notebook.md` | Implementation guide for the git-backed notebook feature |
| `CLAUDE.md` | Claude Code project instructions and extension point reference |
| `README.md` | Project overview and local dev setup |
| `changelog.md` | 14-feature changelog for the `fable-test` branch |

---

## Complexity Hotspots

These files have the highest internal complexity — approach them after you have a mental model from the tour above:

| File | Lines | Why it's complex |
|---|---|---|
| `src/hooks/useGitHubNotebook.ts` | 750 | Orchestrates the entire notebook lifecycle — all state, all API calls, all sync tracking in one hook |
| `src/components/notebook/NoteList.tsx` | 317 | Drag-and-drop, draft creation, deletion confirmations, cross-notebook move — all in one component |
| `src/components/notebook/NoteEditor.tsx` | 374 | Multiple view modes, draft recovery, image upload via paste/drop, keyboard shortcuts |
| `src/services/github.ts` | 329 | 18 GitHub API methods including SHA-based file updates, metadata read/write, and Actions status polling |
| `src/components/notebook/ExpandableNote.tsx` | 223 | Expand/collapse, inline edit, drag-and-drop reordering, async save lifecycle — all combined |
| `src/components/notebook/styles.ts` | 549 | Large centralized style dictionary — changes here affect every component in the workspace |
| `src/hooks/useNoteListInteractions.ts` | 138 | `useReducer`-driven state machine for all note list UI interactions |
| `src/pages/write.tsx` | 209 | Composes 13 imports — high fan-out, easy to break component wiring |
