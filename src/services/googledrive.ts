// Google Drive REST client — the single network boundary for the notebook
// write workspace. Replaces the GitHub Contents API client; the public surface
// mirrors it so the hook layer (useDriveNotebook) needs minimal changes.
//
// Storage layout in the user's Drive:
//   simple-notebook/           ← root folder (created on first use)
//     <notebook>/              ← one subfolder per notebook
//       _metadata.json         ← titles, display order, updated timestamps
//       <note>.md              ← individual notes
//     images/                  ← binary uploads (pasted images)
//
// Auth: an OAuth 2.0 access token passed in at construction time and stored in
// localStorage as `gd_token`. Drive is immediately consistent on writes, so
// there is no polling / eventual-consistency wait after a save.

import {
  DOCS_PATH,
  parseMetadata,
  serializeMetadata,
} from '@site/src/lib/notes';
import type {
  Notebook,
  NoteContent,
  NoteFile,
  NotebookMetadataState,
} from '@site/src/types';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'simple-notebook';
const NOTE_RE = /\.mdx?$/;

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
}

export class DriveError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function stripFrontmatter(raw: string): string {
  const fm = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return fm ? raw.slice(fm[0].length) : raw;
}

export class DriveNotebookClient {
  private readonly token: string;
  private rootIdPromise: Promise<string> | null = null;
  // notebook name → Drive folder ID (cleared when a notebook is deleted)
  private readonly folderIds = new Map<string, string>();

  constructor(token: string) {
    this.token = token;
  }

  // ── auth headers ──────────────────────────────────────────────────────────

  private auth(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async toError(res: Response, fallback: string): Promise<DriveError> {
    let msg = fallback;
    try {
      const body = await res.json();
      msg = (body as { error?: { message?: string } })?.error?.message ?? fallback;
    } catch { /* non-JSON body */ }
    return new DriveError(msg, res.status);
  }

  // ── internal Drive primitives ─────────────────────────────────────────────

  private async findByName(parentId: string, name: string): Promise<DriveItem | null> {
    const q = encodeURIComponent(
      `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`,
    );
    const res = await fetch(
      `${DRIVE_BASE}/files?q=${q}&fields=files(id,name,mimeType)`,
      { headers: this.auth() },
    );
    if (!res.ok) throw await this.toError(res, 'Drive search failed.');
    const data = await res.json() as { files: DriveItem[] };
    return data.files?.[0] ?? null;
  }

  private async listChildren(parentId: string): Promise<DriveItem[]> {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const res = await fetch(
      `${DRIVE_BASE}/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1000`,
      { headers: this.auth() },
    );
    if (!res.ok) throw await this.toError(res, 'Drive list failed.');
    const data = await res.json() as { files: DriveItem[] };
    return data.files ?? [];
  }

  private async mkFolder(name: string, parentId: string): Promise<string> {
    const res = await fetch(`${DRIVE_BASE}/files?fields=id`, {
      method: 'POST',
      headers: this.auth(true),
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (!res.ok) throw await this.toError(res, `Failed to create folder "${name}".`);
    return ((await res.json()) as { id: string }).id;
  }

  private async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findByName(parentId, name);
    return existing ? existing.id : this.mkFolder(name, parentId);
  }

  private getRootId(): Promise<string> {
    if (!this.rootIdPromise) {
      this.rootIdPromise = (async () => {
        const q = encodeURIComponent(
          `name='${ROOT_NAME}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`,
        );
        const res = await fetch(
          `${DRIVE_BASE}/files?q=${q}&fields=files(id)`,
          { headers: this.auth() },
        );
        if (!res.ok) throw await this.toError(res, 'Could not access Drive root folder.');
        const data = await res.json() as { files: DriveItem[] };
        return data.files?.[0]?.id ?? this.mkFolder(ROOT_NAME, 'root');
      })();
    }
    return this.rootIdPromise;
  }

  private async notebookFolderId(notebook: string): Promise<string> {
    if (this.folderIds.has(notebook)) return this.folderIds.get(notebook)!;
    const rootId = await this.getRootId();
    const id = await this.ensureFolder(notebook, rootId);
    this.folderIds.set(notebook, id);
    return id;
  }

  private async imagesFolderId(): Promise<string> {
    const rootId = await this.getRootId();
    return this.ensureFolder('images', rootId);
  }

  // ── text I/O ─────────────────────────────────────────────────────────────

  private async readText(fileId: string): Promise<string> {
    const res = await fetch(
      `${DRIVE_BASE}/files/${fileId}?alt=media`,
      { headers: this.auth() },
    );
    if (!res.ok) throw await this.toError(res, 'Failed to read file.');
    return res.text();
  }

  private async writeText(
    name: string,
    content: string,
    parentId: string,
    existingId: string | null,
  ): Promise<string> {
    const boundary = 'snb-mp-boundary';
    const meta = existingId ? '{}' : JSON.stringify({ name, parents: [parentId] });
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      meta,
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      content,
      `--${boundary}--`,
    ].join('\r\n');

    const url = existingId
      ? `${DRIVE_UPLOAD}/files/${existingId}?uploadType=multipart&fields=id`
      : `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`;
    const res = await fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: {
        ...this.auth(),
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) throw await this.toError(res, 'Failed to write file.');
    return ((await res.json()) as { id: string }).id;
  }

  // Parse a logical path into { notebook?, filename, images? }
  private parsePath(path: string): { notebook?: string; filename: string; images?: true } {
    const docs = path.match(/^docs\/([^/]+)\/(.+)$/);
    if (docs) return { notebook: docs[1], filename: docs[2] };
    const img = path.match(/^static\/img\/notes\/(.+)$/);
    if (img) return { images: true, filename: img[1] };
    return { filename: path.split('/').pop() ?? 'file' };
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Test the token by calling the Drive about endpoint. */
  async verify(): Promise<boolean> {
    try {
      const res = await fetch(
        `${DRIVE_BASE}/about?fields=user`,
        { headers: this.auth() },
      );
      return res.ok;
    } catch { return false; }
  }

  async listNotebooks(): Promise<Notebook[]> {
    const rootId = await this.getRootId();
    const children = await this.listChildren(rootId);
    return children
      .filter(f => f.mimeType === FOLDER_MIME && f.name !== 'images')
      .map(f => ({ name: f.name }));
  }

  async listNotes(notebook: string): Promise<NoteFile[]> {
    const folderId = await this.notebookFolderId(notebook);
    const children = await this.listChildren(folderId);
    return children
      .filter(f => NOTE_RE.test(f.name) && !f.name.startsWith('_'))
      .map(f => ({
        name: f.name,
        sha: f.id,   // Drive file ID in the sha field for delete/update operations
        type: 'file' as const,
        path: `${DOCS_PATH}/${notebook}/${f.name}`,
      }));
  }

  async getNote(notebook: string, name: string): Promise<NoteContent> {
    const folderId = await this.notebookFolderId(notebook);
    const file = await this.findByName(folderId, name);
    if (!file) throw new DriveError(`Note "${name}" not found.`, 404);
    const content = stripFrontmatter(await this.readText(file.id));
    return { content, sha: file.id };
  }

  async getFileByPath(path: string): Promise<NoteContent> {
    const { notebook, filename } = this.parsePath(path);
    if (!notebook) throw new DriveError('Cannot resolve path without a notebook name.', 400);
    return this.getNote(notebook, filename);
  }

  /**
   * Create or update a file. `existingId` is the Drive file ID to update;
   * omit (or pass null) to create. Returns the Drive file ID.
   */
  async putFile(
    path: string,
    _message: string,
    content: string,
    existingId: string | null = null,
  ): Promise<string | null> {
    const { notebook, filename, images } = this.parsePath(path);
    const parentId = images
      ? await this.imagesFolderId()
      : notebook
        ? await this.notebookFolderId(notebook)
        : await this.getRootId();
    return this.writeText(filename, content, parentId, existingId);
  }

  /**
   * Upload a binary file (e.g. a pasted image) to the Drive images folder.
   * The file is made publicly readable so it can be embedded in markdown
   * without requiring an auth token in the URL. Returns a public Drive URL.
   */
  async putBinaryFile(path: string, _message: string, bytes: ArrayBuffer): Promise<string> {
    const { filename } = this.parsePath(path);
    const parentId = await this.imagesFolderId();
    const boundary = 'snb-bin-boundary';
    const meta = JSON.stringify({ name: filename, parents: [parentId] });
    const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const post = `\r\n--${boundary}--`;
    const preBytes = new TextEncoder().encode(pre);
    const postBytes = new TextEncoder().encode(post);
    const combined = new Uint8Array(preBytes.length + bytes.byteLength + postBytes.length);
    combined.set(preBytes, 0);
    combined.set(new Uint8Array(bytes), preBytes.length);
    combined.set(postBytes, preBytes.length + bytes.byteLength);

    const res = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: {
        ...this.auth(),
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: combined,
    });
    if (!res.ok) throw await this.toError(res, 'Image upload failed.');
    const { id } = (await res.json()) as { id: string };

    // Best-effort: make the image publicly readable so it renders without auth.
    fetch(`${DRIVE_BASE}/files/${id}/permissions`, {
      method: 'POST',
      headers: this.auth(true),
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }).catch(() => { /* non-critical */ });

    return `https://drive.google.com/uc?export=view&id=${id}`;
  }

  /** Delete a file by its Drive file ID. The path argument is ignored. */
  async deleteFile(_path: string, fileId: string, _message: string): Promise<void> {
    const res = await fetch(`${DRIVE_BASE}/files/${fileId}`, {
      method: 'DELETE',
      headers: this.auth(),
    });
    if (!res.ok) throw await this.toError(res, 'Delete failed.');
  }

  async getMetadata(notebook: string): Promise<NotebookMetadataState> {
    const empty: NotebookMetadataState = { titles: {}, order: [], updated: {}, sha: null };
    try {
      const folderId = await this.notebookFolderId(notebook);
      const file = await this.findByName(folderId, '_metadata.json');
      if (!file) return empty;
      const raw = await this.readText(file.id);
      const parsed = parseMetadata(JSON.parse(raw));
      return { ...parsed, sha: file.id };
    } catch { return empty; }
  }

  /**
   * Write `_metadata.json`. `currentId` is the existing Drive file ID (or null
   * to create for the first time). Returns the Drive file ID, or `currentId` on
   * failure — metadata errors must never block a note write.
   */
  async putMetadata(
    notebook: string,
    titles: Record<string, string>,
    order: string[],
    updated: Record<string, number>,
    currentId: string | null,
  ): Promise<string | null> {
    try {
      const folderId = await this.notebookFolderId(notebook);
      return await this.writeText(
        '_metadata.json',
        serializeMetadata(titles, order, updated),
        folderId,
        currentId,
      );
    } catch { return currentId; }
  }

  /** Create the notebook folder. Label and position have no Drive equivalent. */
  async createNotebookCategory(slug: string, _label: string, _position: number): Promise<void> {
    await this.notebookFolderId(slug);
  }

  async listAllFiles(notebook: string): Promise<NoteFile[]> {
    const folderId = await this.notebookFolderId(notebook);
    const children = await this.listChildren(folderId);
    return children
      .filter(f => f.mimeType !== FOLDER_MIME)
      .map(f => ({
        name: f.name,
        sha: f.id,
        type: 'file' as const,
        path: `${DOCS_PATH}/${notebook}/${f.name}`,
      }));
  }

  /** Permanently delete the notebook folder and all its contents. */
  async deleteNotebook(notebook: string): Promise<void> {
    const folderId = await this.notebookFolderId(notebook);
    const res = await fetch(`${DRIVE_BASE}/files/${folderId}`, {
      method: 'DELETE',
      headers: this.auth(),
    });
    if (!res.ok) throw await this.toError(res, 'Failed to delete notebook.');
    this.folderIds.delete(notebook);
  }
}

export function createDriveClient(token: string): DriveNotebookClient {
  return new DriveNotebookClient(token);
}
