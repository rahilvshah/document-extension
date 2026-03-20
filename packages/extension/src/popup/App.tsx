import React, { useEffect, useState, useCallback } from 'react';
import type { RecordingState, ExtensionMessage } from '@docext/shared';
import { getLogoSvgMarkup } from '@docext/shared';

const logoSvg28 = getLogoSvgMarkup(28);

const EDITOR_URL = 'http://localhost:3001';

function sendMessage(msg: ExtensionMessage): Promise<any> {
  return chrome.runtime.sendMessage(msg);
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export default function App() {
  const [state, setState] = useState<RecordingState | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const refreshState = useCallback(() => {
    sendMessage({ type: 'GET_STATE' }).then((s) => {
      if (s) setState(s);
    });
  }, []);

  useEffect(() => {
    refreshState();
    const interval = setInterval(refreshState, 1000);
    return () => clearInterval(interval);
  }, [refreshState]);

  useEffect(() => {
    if (!state?.isRecording || !state.startedAt) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - state.startedAt);
    const interval = setInterval(() => {
      setElapsed(Date.now() - state.startedAt!);
    }, 1000);
    return () => clearInterval(interval);
  }, [state?.isRecording, state?.startedAt]);

  const handleStartStop = async () => {
    if (state?.isRecording) {
      const result = await sendMessage({ type: 'STOP_RECORDING' });
      setState(result);
    } else {
      await sendMessage({ type: 'START_RECORDING' });
      window.close();
    }
  };

  const openEditor = () => {
    chrome.tabs.create({ url: EDITOR_URL });
  };

  if (!state) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingText}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.logoBadge}>
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: logoSvg28 }} />
      </div>

      <div style={styles.brand}>DocExt</div>

      <div style={styles.accent} />

      {state.isRecording ? (
        <div style={styles.statusRow}>
          <span style={styles.recordPulse} />
          <span style={styles.statusText}>
            Recording · {formatTime(elapsed)} · {state.eventCount} actions
          </span>
        </div>
      ) : (
        <div style={styles.statusText}>
          Record browser actions into documentation
        </div>
      )}

      <button
        onClick={handleStartStop}
        style={{
          ...styles.cta,
          background: state.isRecording
            ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
            : 'linear-gradient(135deg, #818cf8 0%, #6366f1 100%)',
        }}
      >
        <span>{state.isRecording ? '■  Stop Recording' : '●  Start Recording'}</span>
      </button>

      <button onClick={openEditor} style={styles.secondaryLink}>
        <span style={styles.sparkle}>✦</span>
        Open Editor
        <span style={styles.chevron}>›</span>
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
    paddingTop: 28,
    paddingBottom: 8,
  },
  loadingText: {
    fontSize: 13,
    color: '#94a3b8',
    padding: '40px 0',
  },
  logoBadge: {
    width: 52,
    height: 52,
    borderRadius: 16,
    background: '#f0f0ff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 12px rgba(99,102,241,0.18)',
  },
  brand: {
    fontSize: 22,
    fontWeight: 700,
    color: '#6366f1',
    letterSpacing: '-0.03em',
  },
  accent: {
    width: 28,
    height: 3,
    borderRadius: 2,
    background: '#6366f1',
    opacity: 0.5,
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  recordPulse: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#ef4444',
    boxShadow: '0 0 0 3px rgba(239,68,68,0.2)',
    display: 'inline-block',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  statusText: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center' as const,
    lineHeight: '1.5',
    fontVariantNumeric: 'tabular-nums',
  },
  cta: {
    width: '100%',
    padding: '13px 0',
    border: 'none',
    borderRadius: 14,
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: '0.01em',
    boxShadow: '0 4px 14px rgba(99,102,241,0.25)',
    transition: 'transform 0.1s, box-shadow 0.1s',
  },
  secondaryLink: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    fontSize: 13,
    cursor: 'pointer',
    padding: '6px 0',
    transition: 'color 0.15s',
  },
  sparkle: {
    fontSize: 12,
    color: '#c4b5fd',
  },
  chevron: {
    fontSize: 16,
    marginLeft: 2,
    color: '#cbd5e1',
  },
};
