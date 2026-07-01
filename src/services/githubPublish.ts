// GitHub publish client — pushes selected notebooks from IndexedDB into the
// repo's docs/ folder so Docusaurus serves them in read mode. Uses the Git
// Data API (blobs inlined into one tree) so each publish is a single commit,
// which in turn triggers the Pages deploy workflow.

import {
  BRANCH,
  DOCS_PATH,
  OWNER,
  REPO,
  REPO_API,
  serializeMetadata,
} from '@site/src/lib/notes';
import { localDb } from '@site/src/lib/localDb';

const NOTE_RE = /\.mdx?$/;

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  content?: string;
  sha?: null; // sha: null deletes the path
}

export interface PublishResult {
  /** False when the selected notebooks matched the repo exactly (no commit). */
  committed: boolean;
  commitUrl: string | null;
  /** Notebooks actually included (empty ones are skipped). */
  published: string[];
  /** Notebooks skipped because they contain no notes locally. */
  skippedEmpty: string[];
  upserted: number;
  deleted: number;
}

export interface PublishOptions {
  /** Also delete repo notes missing from the local notebook. Default false. */
  deleteRemote?: boolean;
  onProgress?: (message: string) => void;
}

function headers(token: string, json = true): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function toError(res: Response, fallback: string): Promise<GitHubError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) message = body.message;
  } catch {
    /* non-JSON body — keep the fallback */
  }
  return new GitHubError(message, res.status);
}

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${REPO_API}${path}`, {
    ...init,
    headers: headers(token, init?.method !== undefined),
  });
  if (!res.ok) throw await toError(res, `GitHub request failed (${res.status}).`);
  return (await res.json()) as T;
}

/** Validate the token against the repo; true only with push permission. */
export async function verifyGitHubToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REPO_API, { headers: headers(token, false) });
    if (!res.ok) return false;
    // Classic PATs advertise their scopes; a scope-less classic token can
    // still read a public repo (and report the OWNER's push role), so check
    // the token's own scopes when the header is present. Fine-grained PATs
    // omit the header — for those, permissions reflects the token's grants.
    const scopes = res.headers.get('x-oauth-scopes');
    if (scopes !== null && scopes.trim() !== '') {
      const list = scopes.split(',').map(sc => sc.trim());
      if (!list.includes('repo') && !list.includes('public_repo')) return false;
    }
    const repo = (await res.json()) as { permissions?: { push?: boolean } };
    return repo.permissions?.push === true;
  } catch {
    return false;
  }
}

/**
 * Prepend a YAML frontmatter block carrying the note's title and tags so
 * Docusaurus renders both in read mode. Content that already has frontmatter
 * (legacy notes) is published verbatim; notes without tags keep parity with
 * the historical publish format (no frontmatter).
 */
function withFrontmatter(content: string, title: string, tags: string[]): string {
  if (!tags.length || content.startsWith('---\n')) return content;
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'tags:',
    ...tags.map(t => `  - ${JSON.stringify(t)}`),
    '---',
    '',
    '',
  ];
  return lines.join('\n') + content;
}

/**
 * Publish the given notebooks to `docs/` on the publish branch in one commit.
 * Reads notes and metadata from IndexedDB — callers that want Drive freshness
 * should pull from Drive into IDB first (see pullNotebookFromDrive).
 */
export async function publishNotebooks(
  token: string,
  notebookNames: string[],
  options: PublishOptions = {},
): Promise<PublishResult> {
  const { deleteRemote = false, onProgress } = options;
  const progress = (m: string) => onProgress?.(m);

  // ── 1. Gather the desired state from IndexedDB ────────────────────────────
  const entries: TreeEntry[] = [];
  const desiredByNotebook = new Map<string, Set<string>>();
  const published: string[] = [];
  const skippedEmpty: string[] = [];
  let upserted = 0;

  for (const name of notebookNames) {
    progress(`Reading “${name}” from local storage…`);
    const [notes, meta] = await Promise.all([
      localDb.getNotes(name),
      localDb.getMetadata(name),
    ]);
    if (notes.length === 0) {
      skippedEmpty.push(name);
      continue;
    }
    published.push(name);

    const desired = new Set<string>();
    for (const note of notes) {
      const title = meta?.titles?.[note.name] || note.name.replace(NOTE_RE, '');
      const tags = meta?.tags?.[note.name] ?? [];
      desired.add(note.name);
      entries.push({
        path: `${DOCS_PATH}/${name}/${note.name}`,
        mode: '100644',
        type: 'blob',
        content: withFrontmatter(note.content, title, tags),
      });
      upserted += 1;
    }
    desiredByNotebook.set(name, desired);

    entries.push({
      path: `${DOCS_PATH}/${name}/_metadata.json`,
      mode: '100644',
      type: 'blob',
      content: serializeMetadata(
        meta?.titles ?? {},
        meta?.order ?? notes.map(n => n.name),
        meta?.updated ?? {},
        meta?.tags ?? {},
      ),
    });
  }

  if (published.length === 0) {
    return { committed: false, commitUrl: null, published, skippedEmpty, upserted: 0, deleted: 0 };
  }

  // ── 2. Read the current head + tree ───────────────────────────────────────
  progress('Reading repository state…');
  const ref = await gh<{ object: { sha: string } }>(token, `/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const headCommit = await gh<{ tree: { sha: string } }>(token, `/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;
  const baseTree = await gh<{
    truncated: boolean;
    tree: Array<{ path: string; type: string }>;
  }>(token, `/git/trees/${baseTreeSha}?recursive=1`);

  const existingPaths = new Set(
    baseTree.tree.filter(e => e.type === 'blob').map(e => e.path),
  );

  // ── 3. Category files (only when absent — never clobber labels/positions) ──
  for (const name of published) {
    const categoryPath = `${DOCS_PATH}/${name}/_category_.json`;
    if (!existingPaths.has(categoryPath)) {
      entries.push({
        path: categoryPath,
        mode: '100644',
        type: 'blob',
        content: JSON.stringify({ label: name }, null, 2) + '\n',
      });
    }
  }

  // ── 4. Optional deletions: repo notes missing from the local notebook ─────
  let deleted = 0;
  if (deleteRemote && !baseTree.truncated) {
    for (const [name, desired] of desiredByNotebook) {
      const prefix = `${DOCS_PATH}/${name}/`;
      for (const path of existingPaths) {
        if (!path.startsWith(prefix)) continue;
        const file = path.slice(prefix.length);
        // Only top-level note files; sidecars (_metadata, _category_) survive.
        if (file.includes('/') || !NOTE_RE.test(file) || file.startsWith('_')) continue;
        if (!desired.has(file)) {
          entries.push({ path, mode: '100644', type: 'blob', sha: null });
          deleted += 1;
        }
      }
    }
  }

  // ── 5. One tree, one commit, one ref update ───────────────────────────────
  progress(`Uploading ${entries.length} files…`);
  const newTree = await gh<{ sha: string }>(token, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
  });

  if (newTree.sha === baseTreeSha) {
    progress('Everything already up to date.');
    return { committed: false, commitUrl: null, published, skippedEmpty, upserted, deleted: 0 };
  }

  progress('Creating commit…');
  const nbList = published.join(', ');
  const commit = await gh<{ sha: string; html_url?: string }>(token, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `publish: sync notebook${published.length > 1 ? 's' : ''} ${nbList} to read mode`,
      tree: newTree.sha,
      parents: [headSha],
    }),
  });

  progress('Updating branch…');
  await gh(token, `/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });

  return {
    committed: true,
    commitUrl: commit.html_url ?? `https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`,
    published,
    skippedEmpty,
    upserted,
    deleted,
  };
}
