// Low-profile sync-status dock — a persistent badge in the bottom-right of the
// workspace that reflects background Git activity. Purely presentational: it
// reads flags the data hook already exposes and renders a state-colored dot.
//   • amber, pulsing → a write/sync/refresh is in flight (Saving / Syncing)
//   • green, steady  → everything committed and up to date (Synced)
// A second segment follows the GitHub Pages deploy after a save lands on main:
//   • Deploying… → the Actions run is still building/publishing
//   • Live ✓     → the published site now serves the latest commit

import React from 'react';
import type { DeployStatus } from '@site/src/types';

interface Props {
  saving: boolean;
  syncing: boolean;
  refreshing: boolean;
  deployStatus: DeployStatus;
  deployUrl: string | null;
}

const DEPLOY_INFO: Record<Exclude<DeployStatus, null>, { label: string; color: string }> = {
  deploying: { label: 'Deploying…', color: '#d97706' },
  live: { label: 'Live ✓', color: '#16a34a' },
  failed: { label: 'Deploy failed', color: '#e53e3e' },
};

export default function SyncDock({ saving, syncing, refreshing, deployStatus, deployUrl }: Props) {
  const busy = saving || syncing || refreshing;
  const label = saving ? 'Saving…' : refreshing ? 'Refreshing…' : syncing ? 'Syncing…' : 'Synced';
  const color = busy ? '#d97706' : '#16a34a';
  const deploy = deployStatus ? DEPLOY_INFO[deployStatus] : null;

  return (
    <div style={dock} title={busy ? 'Background sync in progress' : 'All changes synced'}>
      <span
        className={busy ? 'app-dock-dot--active' : undefined}
        style={{ ...dot, backgroundColor: color, boxShadow: `0 0 0 3px ${color}22` }}
      />
      <span style={{ color: 'var(--ifm-color-emphasis-700)' }}>{label}</span>
      {deploy && (
        <>
          <span style={divider} />
          <span
            className={deployStatus === 'deploying' ? 'app-dock-dot--active' : undefined}
            style={{
              ...dot,
              backgroundColor: deploy.color,
              boxShadow: `0 0 0 3px ${deploy.color}22`,
            }}
          />
          {deployUrl ? (
            <a
              href={deployUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: deploy.color, textDecoration: 'none' }}
              title="Open the GitHub Actions run"
            >
              {deploy.label}
            </a>
          ) : (
            <span style={{ color: deploy.color }} title="Waiting for the GitHub Pages deploy">
              {deploy.label}
            </span>
          )}
        </>
      )}
    </div>
  );
}

const dock: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  right: 62,
  zIndex: 90,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 32,
  padding: '0 12px',
  borderRadius: 16,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.01em',
  color: 'var(--ifm-color-emphasis-700)',
  background: 'var(--ifm-background-surface-color)',
  border: '1px solid var(--ifm-color-emphasis-300)',
  boxShadow: '0 4px 16px rgba(17,24,39,0.1)',
  userSelect: 'none',
};

const dot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
};

const divider: React.CSSProperties = {
  width: 1,
  height: 14,
  backgroundColor: 'var(--ifm-color-emphasis-300)',
  flexShrink: 0,
};
