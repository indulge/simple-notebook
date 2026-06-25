// Google Drive access-token capture + validation. The token (a standard OAuth
// 2.0 bearer token) is pasted in, verified against the Drive API, and stored
// in localStorage as `gd_token` — same pattern as the old GitHub PAT gate.

import React, { useState } from 'react';
import { DriveNotebookClient } from '@site/src/services/googledrive';
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
      const ok = await new DriveNotebookClient(token).verify();
      if (ok) {
        localStorage.setItem('gd_token', token);
        onAuthenticated(token);
      } else {
        setError(
          'Token rejected by Google Drive. Make sure it is a valid OAuth access token with Drive scope.',
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
        <h2 style={{ margin: '0 0 8px' }}>Connect to Google Drive</h2>
        <p style={{ margin: '0 0 20px', color: 'var(--ifm-color-emphasis-600)', fontSize: 14 }}>
          Paste a Google OAuth access token to start writing notes. The token needs the{' '}
          <code>https://www.googleapis.com/auth/drive</code> scope. It stays on this device
          and is never sent anywhere other than Google's API.
        </p>
        <input
          type="password"
          placeholder="ya29.…"
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
