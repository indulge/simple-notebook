# Changelog

## 2026-07-02 — Offline-first storage, tags, selective publishing

### Offline-first notebook (IndexedDB primary)
Notes are always stored locally in IndexedDB (`src/lib/localDb.ts`); the workspace opens with no token at all. Connecting Google Drive is optional and enables cross-device sync — writes go to IndexedDB immediately and sync to Drive in the background, with an offline queue that drains when a token arrives (`useNotebook` replaces `useDriveNotebook`).

### Note tags
Notes can be marked with tags from the full-screen editor or the inline tile editor. The tag picker suggests existing tags (union across all notebooks) and creates new ones on Enter/comma. Tags live in each notebook's `_metadata.json` (`tags` field), sync to Drive, and render as chips on note tiles.

### Selective publish to the reading site
A new ⇪ button opens the Publish dialog: pick notebooks, connect a GitHub token (fine-grained PAT, repo contents read/write), and sync them to `docs/` in a single commit via the Git Data API. GitHub Actions then deploys the public read-mode site. Tagged notes are published with YAML frontmatter (`title`, `tags`) so Docusaurus shows tags in read mode. Deleting remote notes that no longer exist locally is opt-in (checkbox, default off).

### Branch consolidation
Merged `docs/concepts-map` (CONCEPTS.md), `docs/claude-code-extension-points` (extension-points reference), and the `origin/main` content commits (workshop notes). The `vite-migration` branch was intentionally not merged — it replaces the Docusaurus architecture wholesale and is incompatible with the current site.

---

# Changelog — fable-test branch

## Key Features & Fixes

### 1. Editor: Edit / Split / Preview modes
`NoteEditor` gains a 3-way mode toggle (`edit | split | preview`) so you can write and preview side-by-side. Previously it was just edit + preview toggle.

### 2. Image paste/drop upload
You can paste or drop an image directly into the editor. It uploads to `static/img/notes/<name>` in the repo via a new `uploadImage` hook action, and inserts a `/img/…` markdown URL. The live preview maps that URL to raw GitHub contents so images show immediately before the Pages deploy finishes.

### 3. localStorage draft safety net
A `draftStorageKey` function + draft read/write logic in the editor saves your work locally on every keystroke. On re-open it offers to restore the draft. On successful save the draft is cleared.

### 4. Notebook delete
A `deleteNotebook` action is wired up end-to-end — Sidebar button (shown on hover) → `useGitHubNotebook.deleteNotebook()` → `github.ts` client. Includes a `deletingNotebook` loading state.

### 5. Move note between notebooks
A 📂 button per note opens a dropdown to pick a target notebook. The note's content and metadata are copied to the target then removed from the source — all in one flow via a new `moveNote` hook action.

### 6. Quick capture (`/write?quick=1`)
A "✏️ Quick note" navbar link jumps straight into a blank editor in the `inbox` notebook (creating it on demand), skipping the notebook-picking ceremony.

### 7. GitHub Pages deploy watcher in SyncDock
After any write (save, delete, create, move), `watchDeploy()` starts polling the Actions API every 10s for up to 10 minutes. SyncDock shows a second status segment: **Deploying…** (amber, pulsing) → **Live ✓** (green) or **Deploy failed** (red), with a link to the Actions run.

### 8. Non-blocking save flow
The SaveModal progress bar is removed. The save now pushes, re-baselines the editor, and releases the UI immediately. The SyncDock's existing sync indicator + the new deploy watcher handle background confirmation.

### 9. Local search (Docusaurus plugin)
`@easyops-cn/docusaurus-search-local` is added with hashed indexes scoped to the `read/` docs route.

### 10. Navbar populated
Previously empty `items: []`. Now has: **Read** (sidebar link), **Write**, **✏️ Quick note**, **GitHub**.

### 11. Homepage notebook listing cache
`sessionStorage` caches the live notebook listing for 5 minutes to stay under GitHub's unauthenticated rate limit (~60 req/hr).

### 12. TokenGate: fine-grained PAT guidance
Error message and instruction text updated to recommend a fine-grained token scoped to this repo only (`Contents: Read and write`), instead of a broad `repo`-scope classic token. Placeholder updated to accept both `github_pat_…` and `ghp_…`.

### 13. Test data cleanup
All `docs/test-notes/`, `docs/test2/`, `docs/test3/`, `docs/test-another-notebook/`, `docs/empty-notebook/` fixture directories are deleted.

### 14. `arch.md` added
A 295-line architecture document describing the system design.
