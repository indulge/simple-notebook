import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { usePluginData } from '@docusaurus/useGlobalData';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {
  API, DOCS_PATH, BRANCH,
  parseMetadata, orderNotes, noteUpdatedAt, formatTimestamp,
} from '@site/src/lib/notes';
import styles from './index.module.css';

const GH_HEADERS = { Accept: 'application/vnd.github+json' };
const NOTE_RE = /\.mdx?$/;

// ── Live (unauthenticated) GitHub reads ──────────────────────────────────────
// The public repo is readable without a token; we drop the Authorization header
// the Write app uses. Unauthenticated requests are rate-limited (~60/hr per IP),
// so failures fall back to the build-time snapshot.

async function fetchDirFiles(dir) {
  const res = await fetch(`${API}/${DOCS_PATH}/${dir}?ref=${BRANCH}&_=${Date.now()}`, { headers: GH_HEADERS });
  if (!res.ok) throw res;
  return (await res.json())
    .filter(i => i.type === 'file' && NOTE_RE.test(i.name) && !i.name.startsWith('_'))
    .map(i => ({ name: i.name }));
}

async function fetchDirMetadata(dir) {
  try {
    const res = await fetch(`${API}/${DOCS_PATH}/${dir}/_metadata.json?ref=${BRANCH}&_=${Date.now()}`, { headers: GH_HEADERS });
    if (res.ok) {
      const data = await res.json();
      // The contents API returns base64; decode without pulling in b64Decode's
      // escape() path — atob + a JSON parse is enough for this small file.
      return parseMetadata(JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))));
    }
  } catch { /* fall through to empty */ }
  return parseMetadata(null);
}

async function fetchLiveNotebooks() {
  const res = await fetch(`${API}/${DOCS_PATH}?ref=${BRANCH}&_=${Date.now()}`, { headers: GH_HEADERS });
  if (!res.ok) {
    const err = new Error(res.status === 403 ? 'rate-limited' : 'fetch-failed');
    err.rateLimited = res.status === 403;
    throw err;
  }
  const dirs = (await res.json()).filter(i => i.type === 'dir');
  const notebooks = await Promise.all(dirs.map(async (d) => {
    const [files, meta] = await Promise.all([fetchDirFiles(d.name), fetchDirMetadata(d.name)]);
    const notes = orderNotes(files, meta.order).map(n => ({
      file: n.name,
      id: `${d.name}/${n.name.replace(NOTE_RE, '')}`,
      title: meta.titles[n.name] || n.name.replace(NOTE_RE, ''),
      updated: noteUpdatedAt(n.name, meta.updated),
    }));
    return { dir: d.name, notes };
  }));
  return notebooks.filter(nb => nb.notes.length > 0);
}

// ── Hub ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  const snapshot = usePluginData('notebook-snapshot');
  const snapNotebooks = snapshot?.notebooks ?? [];

  // Build-time facts used to (a) seed the initial render, (b) keep notebook
  // labels/order, and (c) decide whether a live note is actually deployed yet.
  const publishedSet = useMemo(
    () => new Set(snapNotebooks.flatMap(nb => nb.notes.map(n => n.id))),
    [snapNotebooks]
  );
  const labelMap = useMemo(
    () => new Map(snapNotebooks.map(nb => [nb.dir, nb.label])),
    [snapNotebooks]
  );
  const snapOrder = useMemo(() => snapNotebooks.map(nb => nb.dir), [snapNotebooks]);

  const seed = useMemo(
    () => snapNotebooks.map(nb => ({
      dir: nb.dir,
      label: nb.label,
      notes: nb.notes.map(n => ({ ...n, published: true })),
    })),
    [snapNotebooks]
  );

  const [notebooks, setNotebooks] = useState(seed);
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'
  const [errorKind, setErrorKind] = useState(null);
  const [focused, setFocused] = useState(null); // notebook dir, or null for "all"

  const refresh = useCallback(async () => {
    setStatus('loading');
    setErrorKind(null);
    try {
      const live = await fetchLiveNotebooks();
      live.sort((a, b) => {
        const ia = snapOrder.indexOf(a.dir);
        const ib = snapOrder.indexOf(b.dir);
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      });
      setNotebooks(live.map(nb => ({
        dir: nb.dir,
        label: labelMap.get(nb.dir) || nb.dir,
        notes: nb.notes.map(n => ({ ...n, published: publishedSet.has(n.id) })),
      })));
      setStatus('ok');
    } catch (e) {
      setErrorKind(e.rateLimited ? 'rate-limited' : 'error');
      setStatus('error');
    }
  }, [labelMap, publishedSet, snapOrder]);

  // Pull the live listing once on mount so freshly-committed notes show up.
  useEffect(() => { refresh(); }, [refresh]);

  const visible = focused ? notebooks.filter(nb => nb.dir === focused) : notebooks;

  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <header className={styles.heroBanner}>
        <div className="container">
          <Heading as="h1">{siteConfig.title}</Heading>
          <p>{siteConfig.tagline}</p>
        </div>
      </header>
      <main className="container margin-vert--lg">
        <div className={styles.toolbar}>
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            {focused ? (
              <>
                <button className={styles.crumbLink} onClick={() => setFocused(null)}>Home</button>
                <span className={styles.crumbSep}>›</span>
                <span className={styles.crumbCurrent}>{labelMap.get(focused) || focused}</span>
              </>
            ) : (
              <span className={styles.crumbCurrent}>Home</span>
            )}
          </nav>
          <div className={styles.refreshRow}>
            <span className={status === 'error' ? `${styles.refreshNote} ${styles.refreshNoteError}` : styles.refreshNote}>
              {status === 'loading' && 'Checking for updates…'}
              {status === 'ok' && 'Up to date'}
              {status === 'error' && (errorKind === 'rate-limited'
                ? 'GitHub rate limit reached — showing the last published version.'
                : "Couldn't refresh — showing the last published version.")}
            </span>
            <button
              className="button button--secondary button--sm"
              onClick={refresh}
              disabled={status === 'loading'}
            >
              {status === 'loading' ? '⟳ Refreshing…' : '↻ Refresh'}
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className={styles.emptyState}>
            <p>No notebooks yet.</p>
          </div>
        ) : (
          <div className={styles.notebookGrid}>
            {visible.map(nb => (
              <section key={nb.dir} className={styles.notebookCard}>
                <div className={styles.notebookHeader}>
                  <button
                    className={styles.notebookTitle}
                    onClick={() => setFocused(focused === nb.dir ? null : nb.dir)}
                    title={focused === nb.dir ? 'Show all notebooks' : 'Focus this notebook'}
                  >
                    📓 {nb.label}
                  </button>
                  <span className={styles.noteCount}>
                    {nb.notes.length} {nb.notes.length === 1 ? 'note' : 'notes'}
                  </span>
                </div>
                <ul className={styles.noteList}>
                  {nb.notes.map(note => (
                    <li key={note.id} className={styles.noteRow}>
                      {note.published ? (
                        <Link to={`/docs/${note.id}`} className={styles.noteLink}>{note.title}</Link>
                      ) : (
                        <span className={styles.notePending}>
                          {note.title}
                          <span className={styles.pendingBadge} title="Committed but not yet deployed">
                            publishing… (live in ~a minute)
                          </span>
                        </span>
                      )}
                      {note.updated && (
                        <span className={styles.noteUpdated} title={`Last updated ${formatTimestamp(note.updated)}`}>
                          {formatTimestamp(note.updated)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </Layout>
  );
}
