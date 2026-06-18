// GitHub Contents API client — the single network boundary for the notebook
// app. Everything that touches `fetch`, builds a commit payload, or decodes a
// GitHub response lives here. The React layer (hooks/components) talks only to
// this typed surface and never constructs a request itself.
//
// The same client serves both the authenticated Write app (a personal access
// token is supplied) and the public reading hub (no token — anonymous reads,
// subject to GitHub's per-IP rate limit, surfaced as a 403 `GitHubError`).

import {
  API,
  BRANCH,
  DOCS_PATH,
  REPO_API,
  b64Decode,
  b64Encode,
  parseMetadata,
  serializeMetadata,
} from '@site/src/lib/notes';
import type {
  DeployRun,
  GitHubContentEntry,
  GitHubErrorResponse,
  GitHubFileResponse,
  GitHubWriteResponse,
  Notebook,
  NoteContent,
  NoteFile,
  NotebookMetadataState,
} from '@site/src/types';

const NOTE_RE = /\.mdx?$/;

/** A note file is a markdown file that is not an underscore-prefixed sidecar. */
function isNoteFile(name: string): boolean {
  return NOTE_RE.test(name) && !name.startsWith('_');
}

/** Strip a leading YAML frontmatter block (back-compat with older notes). */
export function stripFrontmatter(raw: string): string {
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return fm ? raw.slice(fm[0].length) : raw;
}

/**
 * A failed GitHub request. Carries the HTTP status so callers can branch on
 * the cases that matter — auth (401/403), rate limiting (403), and the
 * optimistic-concurrency merge conflict (409) — without re-parsing responses.
 */
export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }

  /** Stale-SHA / merge conflict on a write. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** Token missing, rejected, or rate-limited. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimited(): boolean {
    return this.status === 403;
  }
}

export class GitHubNotebookClient {
  private readonly token: string | null;

  constructor(token: string | null = null) {
    this.token = token;
  }

  // ── request plumbing ──────────────────────────────────────────────────────

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** Read URL for a path under the repo, cache-busted and pinned to the branch. */
  private readUrl(path: string): string {
    return `${API}/${path}?ref=${BRANCH}&_=${Date.now()}`;
  }

  /** Throw a typed error carrying GitHub's message and the HTTP status. */
  private async toError(res: Response, fallback: string): Promise<GitHubError> {
    let message = fallback;
    try {
      const body = (await res.json()) as GitHubErrorResponse;
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON body — keep the fallback */
    }
    return new GitHubError(message, res.status);
  }

  // ── auth ──────────────────────────────────────────────────────────────────

  /** Validate the current token against the repo. Resolves true/false; never throws. */
  async verify(): Promise<boolean> {
    try {
      const res = await fetch(`${API}/${DOCS_PATH}`, { headers: this.headers(false) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── notebooks ──────────────────────────────────────────────────────────────

  async listNotebooks(): Promise<Notebook[]> {
    const res = await fetch(this.readUrl(DOCS_PATH), { headers: this.headers(false) });
    if (!res.ok) throw await this.toError(res, 'Failed to list notebooks.');
    const data = (await res.json()) as GitHubContentEntry[];
    return data.filter((i) => i.type === 'dir').map((i) => ({ name: i.name }));
  }

  // ── notes ──────────────────────────────────────────────────────────────────

  async listNotes(notebook: string): Promise<NoteFile[]> {
    const res = await fetch(this.readUrl(`${DOCS_PATH}/${notebook}`), {
      headers: this.headers(false),
    });
    if (!res.ok) throw await this.toError(res, 'Failed to list notes.');
    const data = (await res.json()) as GitHubContentEntry[];
    return data
      .filter((i) => i.type === 'file' && isNoteFile(i.name))
      .map((i) => ({ name: i.name, sha: i.sha, type: 'file', path: i.path }));
  }

  /** Load a note's body (frontmatter stripped) and its current SHA. */
  async getNote(notebook: string, name: string): Promise<NoteContent> {
    return this.getFileByPath(`${DOCS_PATH}/${notebook}/${name}`);
  }

  /** Load any repo file by full path, returning decoded body + SHA. */
  async getFileByPath(path: string): Promise<NoteContent> {
    const res = await fetch(this.readUrl(path), { headers: this.headers(false) });
    if (!res.ok) throw await this.toError(res, 'Failed to load note.');
    const data = (await res.json()) as GitHubFileResponse;
    return { content: stripFrontmatter(b64Decode(data.content)), sha: data.sha };
  }

  /**
   * Create or update a file. Returns the new blob SHA. Pass `sha` to update an
   * existing file (omit it to create). A 409 surfaces as `GitHubError.isConflict`.
   */
  async putFile(
    path: string,
    message: string,
    content: string,
    sha?: string | null,
  ): Promise<string | null> {
    const res = await fetch(`${API}/${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({
        message,
        content: b64Encode(content),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw await this.toError(res, 'Save failed.');
    const data = (await res.json()) as GitHubWriteResponse;
    return data.content?.sha ?? sha ?? null;
  }

  /**
   * Create a binary file (e.g. a pasted image) from raw bytes. Unlike
   * `putFile`, the payload is base64-encoded straight from the buffer with no
   * text round-trip. Create-only: collisions are avoided by unique filenames.
   */
  async putBinaryFile(path: string, message: string, bytes: ArrayBuffer): Promise<void> {
    let binary = '';
    const view = new Uint8Array(bytes);
    const chunk = 0x8000; // keep String.fromCharCode under the arg-count limit
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode(...view.subarray(i, i + chunk));
    }
    const res = await fetch(`${API}/${path}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ message, content: btoa(binary), branch: BRANCH }),
    });
    if (!res.ok) throw await this.toError(res, 'Image upload failed.');
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    const res = await fetch(`${API}/${path}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({ message, sha, branch: BRANCH }),
    });
    if (!res.ok) throw await this.toError(res, 'Delete failed.');
  }

  // ── per-notebook metadata (_metadata.json) ──────────────────────────────────

  /** Load and parse a notebook's `_metadata.json`; missing/invalid → empty state. */
  async getMetadata(notebook: string): Promise<NotebookMetadataState> {
    const empty: NotebookMetadataState = { titles: {}, order: [], updated: {}, sha: null };
    try {
      const res = await fetch(this.readUrl(`${DOCS_PATH}/${notebook}/_metadata.json`), {
        headers: this.headers(false),
      });
      if (!res.ok) return empty;
      const data = (await res.json()) as GitHubFileResponse;
      const parsed = parseMetadata(JSON.parse(b64Decode(data.content)));
      return { ...parsed, sha: data.sha };
    } catch {
      return empty;
    }
  }

  /**
   * Commit an updated `_metadata.json`. Metadata is non-critical bookkeeping, so
   * a failure resolves to the previous SHA rather than throwing — a missed title
   * sync must never block the note write that triggered it.
   */
  async putMetadata(
    notebook: string,
    titles: Record<string, string>,
    order: string[],
    updated: Record<string, number>,
    currentSha: string | null,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${API}/${DOCS_PATH}/${notebook}/_metadata.json`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          message: 'chore: update note metadata',
          content: b64Encode(serializeMetadata(titles, order, updated)),
          branch: BRANCH,
          ...(currentSha ? { sha: currentSha } : {}),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as GitHubWriteResponse;
        return data.content?.sha ?? currentSha;
      }
    } catch {
      /* swallow — see doc comment */
    }
    return currentSha;
  }

  // ── notebook creation / deletion ─────────────────────────────────────────

  /** Write a `_category_.json` so a new directory shows up as a notebook. */
  async createNotebookCategory(slug: string, label: string, position: number): Promise<void> {
    await this.putFile(
      `${DOCS_PATH}/${slug}/_category_.json`,
      `Create notebook: ${label}`,
      JSON.stringify({ label, position }, null, 2),
    );
  }

  /** List every file in a notebook directory, including `_`-prefixed sidecars. */
  async listAllFiles(notebook: string): Promise<NoteFile[]> {
    const res = await fetch(this.readUrl(`${DOCS_PATH}/${notebook}`), {
      headers: this.headers(false),
    });
    if (!res.ok) throw await this.toError(res, 'Failed to list notebook contents.');
    const data = (await res.json()) as GitHubContentEntry[];
    return data
      .filter((i) => i.type === 'file')
      .map((i) => ({ name: i.name, sha: i.sha, type: 'file', path: i.path }));
  }

  /**
   * Delete a notebook by deleting every file in its directory (git drops empty
   * directories automatically). Sequential on purpose: parallel deletes against
   * the same branch race on the head commit and 409.
   */
  async deleteNotebook(notebook: string): Promise<void> {
    const files = await this.listAllFiles(notebook);
    for (const f of files) {
      if (f.sha) await this.deleteFile(f.path, f.sha, `Delete notebook: ${notebook}`);
    }
  }

  // ── deploy status (GitHub Actions) ───────────────────────────────────────

  /** The most recent workflow run on the branch, or null if none/unavailable. */
  async getLatestDeployRun(): Promise<DeployRun | null> {
    try {
      const res = await fetch(
        `${REPO_API}/actions/runs?branch=${BRANCH}&per_page=1&_=${Date.now()}`,
        { headers: this.headers(false) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        workflow_runs?: Array<{
          status: string;
          conclusion: string | null;
          html_url: string;
          created_at: string;
        }>;
      };
      const run = data.workflow_runs?.[0];
      if (!run) return null;
      return {
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        createdAt: Date.parse(run.created_at),
      };
    } catch {
      return null;
    }
  }
}

/** Convenience factory mirroring the class constructor. */
export function createGitHubClient(token: string | null = null): GitHubNotebookClient {
  return new GitHubNotebookClient(token);
}
