// Google Drive token capture + validation. The user generates an API access
// token from Google Cloud Console (OAuth Playground or similar), pastes it here,
// and it is verified against the Drive API before being stored in localStorage.
// Connecting Drive is optional — notes are stored locally (IndexedDB) either way.

import React, { useState } from 'react';
import { DriveNotebookClient } from '@site/src/services/googledrive';
import { s } from './styles';

interface Props {
  onAuthenticated: (token: string) => void;
  onDismiss?: () => void;
  onSkip?: () => void;  // use app without Drive
}

export default function TokenGate({ onAuthenticated, onDismiss, onSkip }: Props) {
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
          'Token rejected by Google Drive. Make sure it is a valid access token with Drive scope.',
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
        <p style={{ margin: '0 0 8px', color: 'var(--ifm-color-emphasis-600)', fontSize: 14 }}>
          Paste a Google API access token to enable Drive sync. Generate one from Google Cloud
          Console (OAuth Playground) with the{' '}
          <code>https://www.googleapis.com/auth/drive</code> scope.
        </p>
        <p style={{ margin: '0 0 20px', color: 'var(--ifm-color-emphasis-500)', fontSize: 13 }}>
          Without Drive, notes are saved locally in your browser (IndexedDB).
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
          {testing ? 'Verifying…' : 'Connect Drive'}
        </button>
        {onSkip && (
          <button
            onClick={onSkip}
            style={{ ...s.btn, ...s.btnGhost, width: '100%', marginTop: 10 }}
          >
            Use without Drive (local only)
          </button>
        )}
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
