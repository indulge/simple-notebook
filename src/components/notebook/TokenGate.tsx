// GitHub personal-access-token capture + validation. Verification goes through
// the service (a throwaway client for the entered token) so this component
// holds no fetch logic of its own.

import React, { useState } from 'react';
import { createGitHubClient } from '@site/src/services/github';
import { s } from './styles';

interface Props {
  onAuthenticated: (token: string) => void;
  onDismiss?: () => void;
}

export default function TokenGate({ onAuthenticated, onDismiss }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);

  const handleSave = async () => {
    const token = value.trim();
    if (!token) return;
    setTesting(true);
    setError('');
    try {
      const ok = await createGitHubClient(token).verify();
      if (ok) {
        localStorage.setItem('gh_pat', token);
        onAuthenticated(token);
      } else {
        setError(
          'Token rejected by GitHub. Check that it can access this repository with Contents read/write.',
        );
      }
    } catch {
      setError('Network error. Check your connection.');
    }
    setTesting(false);
  };

  return (
    <div style={s.gate}>
      <div style={s.gateCard}>
        {onDismiss && (
          <button onClick={onDismiss} style={s.gateClose} title="Dismiss">
            ✕
          </button>
        )}
        <h2 style={{ margin: '0 0 8px' }}>Connect to GitHub</h2>
        <p style={{ margin: '0 0 20px', color: 'var(--ifm-color-emphasis-600)', fontSize: 14 }}>
          Paste a GitHub Personal Access Token to start writing notes. Use a{' '}
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
          >
            fine-grained token
          </a>{' '}
          scoped to <strong>only this repository</strong> with{' '}
          <code>Contents: Read and write</code> permission — safer than a classic{' '}
          <code>repo</code>-scope token, which grants access to all your repos.
        </p>
        <input
          type="password"
          placeholder="github_pat_… or ghp_…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          style={s.input}
          autoFocus
        />
        {error && <p style={{ color: '#e53e3e', fontSize: 13, margin: '0 0 12px' }}>{error}</p>}
        <button
          onClick={handleSave}
          disabled={testing || !value.trim()}
          style={{ ...s.btn, ...s.btnPrimary, width: '100%' }}
        >
          {testing ? 'Verifying…' : 'Save Token & Continue'}
        </button>
        <p
          style={{
            margin: '16px 0 0',
            fontSize: 12,
            color: 'var(--ifm-color-emphasis-500)',
            textAlign: 'center',
          }}
        >
          Token stays on this device. Never written to source code.
        </p>
      </div>
    </div>
  );
}
