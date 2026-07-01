// Selective read-mode publishing. Pick notebooks, connect a GitHub token
// (fine-grained PAT with contents read/write on the repo), and sync them to
// docs/ in one commit — GitHub Actions then deploys the public reading site.
// Notebooks are read from IndexedDB; when Drive is connected each selected
// notebook is pulled from Drive first so the freshest copy is published.

import React, { useEffect, useState } from 'react';
import { OWNER, REPO } from '@site/src/lib/notes';
import { pullNotebookFromDrive } from '@site/src/hooks/useNotebook';
import { DriveNotebookClient } from '@site/src/services/googledrive';
import {
  publishNotebooks,
  verifyGitHubToken,
  type PublishResult,
} from '@site/src/services/githubPublish';
import type { Notebook } from '@site/src/types';
import { s } from './styles';

const TOKEN_KEY = 'gh_token';
const SELECTION_KEY = 'publish_selection';
const SITE_URL = `https://${OWNER}.github.io/${REPO}/`;

interface Props {
  notebooks: Notebook[];
  driveToken: string | null;
  onClose: () => void;
}

type Phase = 'idle' | 'publishing' | 'done' | 'error';

function loadSelection(existing: Notebook[]): Set<string> {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return new Set();
    const names = JSON.parse(raw) as string[];
    const valid = new Set(existing.map(n => n.name));
    return new Set(names.filter(n => valid.has(n)));
  } catch {
    return new Set();
  }
}

export default function PublishModal({ notebooks, driveToken, onClose }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [tokenError, setTokenError] = useState('');

  const [selected, setSelected] = useState<Set<string>>(() => loadSelection(notebooks));
  const [deleteRemote, setDeleteRemote] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [progressMsg, setProgressMsg] = useState('');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
  }, []);

  const connect = async () => {
    const t = tokenInput.trim();
    if (!t) return;
    setVerifying(true);
    setTokenError('');
    const ok = await verifyGitHubToken(t);
    setVerifying(false);
    if (ok) {
      localStorage.setItem(TOKEN_KEY, t);
      setToken(t);
      setTokenInput('');
    } else {
      setTokenError(
        `Token rejected. It needs read/write access to the contents of ${OWNER}/${REPO}.`,
      );
    }
  };

  const disconnect = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };

  const toggle = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify(Array.from(next)));
      } catch { /* best-effort */ }
      return next;
    });
  };

  const publish = async () => {
    if (!token || selected.size === 0) return;
    setPhase('publishing');
    setPublishError('');
    const names = Array.from(selected);
    try {
      if (driveToken) {
        const drive = new DriveNotebookClient(driveToken);
        for (const name of names) {
          setProgressMsg(`Pulling “${name}” from Drive…`);
          try {
            await pullNotebookFromDrive(drive, name);
          } catch { /* publish the local copy if the Drive pull fails */ }
        }
      }
      const res = await publishNotebooks(token, names, {
        deleteRemote,
        onProgress: setProgressMsg,
      });
      setResult(res);
      setPhase('done');
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : 'Publish failed.');
      setPhase('error');
    }
  };

  const busy = phase === 'publishing';

  return (
    <div style={s.modalOverlay}>
      <div style={{ ...s.modalCard, maxWidth: 460, width: '100%', textAlign: 'left' }}>
        <h3 style={{ margin: '0 0 6px' }}>Publish to reading site</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ifm-color-emphasis-600)' }}>
          Sync selected notebooks to the GitHub repo — they appear in{' '}
          <a href={SITE_URL} target="_blank" rel="noreferrer">read mode</a> once the
          deploy finishes (~2 min).
        </p>

        {/* ── GitHub connection ── */}
        {token ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
            <span style={{ color: '#38a169' }}>✓ GitHub connected</span>
            <button onClick={disconnect} style={{ ...s.btn, ...s.btnGhost, padding: '2px 8px', fontSize: 12 }}>
              Disconnect
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && connect()}
              placeholder="GitHub token (repo contents read/write)"
              style={{ ...s.input, marginBottom: 8 }}
            />
            {tokenError && (
              <p style={{ fontSize: 12, color: '#e53e3e', margin: '0 0 8px' }}>{tokenError}</p>
            )}
            <button
              onClick={connect}
              disabled={verifying || !tokenInput.trim()}
              style={{ ...s.btn, ...s.btnPrimary, width: '100%' }}
            >
              {verifying ? 'Verifying…' : 'Connect GitHub'}
            </button>
          </div>
        )}

        {/* ── Notebook selection ── */}
        <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
          {notebooks.length === 0 && <div style={s.hint}>No notebooks yet.</div>}
          {notebooks.map(nb => (
            <label
              key={nb.name}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', fontSize: 14, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={selected.has(nb.name)}
                onChange={() => toggle(nb.name)}
                disabled={busy}
              />
              <span style={s.notebookIcon}>📓</span>
              {nb.name}
            </label>
          ))}
        </div>

        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ifm-color-emphasis-600)', marginBottom: 14, cursor: 'pointer' }}
          title="When enabled, notes that exist in the repo but not in the selected local notebook are removed from the site."
        >
          <input
            type="checkbox"
            checked={deleteRemote}
            onChange={e => setDeleteRemote(e.target.checked)}
            disabled={busy}
          />
          Also remove published notes that no longer exist locally
        </label>

        {/* ── Status ── */}
        {busy && (
          <div style={{ marginBottom: 12 }}>
            <div style={s.modalProgressTrack}>
              <div style={{ height: '100%', borderRadius: 3, width: '70%', backgroundColor: 'var(--ifm-color-primary)', opacity: 0.7 }} />
            </div>
            <p style={{ fontSize: 12, color: 'var(--ifm-color-emphasis-600)', margin: '8px 0 0' }}>{progressMsg}</p>
          </div>
        )}
        {phase === 'error' && (
          <p style={{ fontSize: 13, color: '#e53e3e', margin: '0 0 12px' }}>{publishError}</p>
        )}
        {phase === 'done' && result && (
          <div style={{ fontSize: 13, margin: '0 0 12px', color: 'var(--ifm-color-emphasis-700)' }}>
            {result.committed ? (
              <>
                ✓ Published {result.published.join(', ')} — {result.upserted} note
                {result.upserted === 1 ? '' : 's'}
                {result.deleted > 0 ? `, ${result.deleted} removed` : ''}.{' '}
                {result.commitUrl && (
                  <a href={result.commitUrl} target="_blank" rel="noreferrer">View commit</a>
                )}
              </>
            ) : result.published.length > 0 ? (
              <>✓ Already up to date — nothing to publish.</>
            ) : (
              <>Nothing to publish{result.skippedEmpty.length ? ` — ${result.skippedEmpty.join(', ')} ${result.skippedEmpty.length === 1 ? 'is' : 'are'} empty` : ''}.</>
            )}
            {result.skippedEmpty.length > 0 && result.published.length > 0 && (
              <> Skipped empty: {result.skippedEmpty.join(', ')}.</>
            )}
          </div>
        )}

        {/* ── Actions ── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{ ...s.btn, ...s.btnGhost }}>
            Close
          </button>
          <button
            onClick={publish}
            disabled={busy || !token || selected.size === 0}
            style={{ ...s.btn, ...s.btnPrimary }}
            title={!token ? 'Connect GitHub first' : selected.size === 0 ? 'Select at least one notebook' : undefined}
          >
            {busy ? 'Publishing…' : `Publish ${selected.size || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
