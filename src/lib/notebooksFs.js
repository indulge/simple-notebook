// Node-only build-time reader. Walks docs/* and returns an ordered, normalized
// view of every notebook and its notes, driven by each notebook's
// _metadata.json + _category_.json. Imported only by sidebars.js and the
// notebook-snapshot plugin — never by the browser bundle.

import fs from 'node:fs';
import path from 'node:path';
import { parseMetadata, orderNotes, noteUpdatedAt } from './notes.js';

const NOTE_RE = /\.mdx?$/;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Returns notebooks sorted by _category_.json `position`, each shaped as:
//   { dir, label, position, hasMetadata,
//     notes: [{ file, id: "<dir>/<file-without-ext>", title, updated }] }
// Notebooks with no note files are skipped (an empty sidebar category throws).
export function readNotebooksFromDisk(docsDir = 'docs') {
  const root = path.resolve(docsDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const notebooks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const dirPath = path.join(root, dir);

    const files = fs
      .readdirSync(dirPath)
      .filter(name => NOTE_RE.test(name) && !name.startsWith('_'));
    if (files.length === 0) continue; // skip empty notebooks

    const category = readJson(path.join(dirPath, '_category_.json')) || {};
    const label = typeof category.label === 'string' ? category.label : dir;
    const position = typeof category.position === 'number' ? category.position : Number.MAX_SAFE_INTEGER;

    const rawMeta = readJson(path.join(dirPath, '_metadata.json'));
    const hasMetadata = rawMeta != null;
    const { titles, order, updated } = parseMetadata(rawMeta);

    // Order the real files by metadata order; unknown files are appended,
    // metadata entries with no file on disk are dropped.
    const ordered = orderNotes(files.map(name => ({ name })), order);

    const notes = ordered.map(({ name }) => ({
      file: name,
      id: `${dir}/${name.replace(NOTE_RE, '')}`,
      title: titles[name] || name.replace(NOTE_RE, ''),
      updated: noteUpdatedAt(name, updated),
    }));

    notebooks.push({ dir, label, position, hasMetadata, notes });
  }

  notebooks.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  return notebooks;
}
