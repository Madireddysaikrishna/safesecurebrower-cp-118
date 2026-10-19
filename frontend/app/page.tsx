'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useRemoteBrowser, SessionState } from '../hooks/useRemoteBrowser';

function LandingView({ onStart }: { onStart: () => void }) {
  return (
    <div className="landing animate-in">
      <div className="landing-badge">
        <span className="landing-badge-dot" />
        Remote Browser Control
      </div>

      <div className="landing-hero">
        <h1 className="landing-title">Browse</h1>
        <p className="landing-subtitle">
          Stream and control a real Chromium browser running in a Docker container,
          from right here in the browser tab.
        </p>
      </div>

      <button className="start-btn" onClick={onStart} id="start-browser-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        Start Browser
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </button>

      <div className="flow-steps">
        {[
          { n: '1', text: 'Click "Start Browser"' },
          { n: '2', text: 'Docker spins up Chromium' },
          { n: '3', text: 'Stream appears — interact live' },
        ].map((step, i, arr) => (
          <span key={step.n} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <span className="flow-step">
              <span className="flow-step-num">{step.n}</span>
              <span className="flow-step-text">{step.text}</span>
            </span>
            {i < arr.length - 1 && <span className="flow-arrow">›</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ state, msg }: { state: SessionState; msg: string }) {
  const labels: Record<SessionState, string> = {
    idle:         'Idle',
    connecting:   'Connecting...',
    reconnecting: msg || 'Resuming session...',
    booting:      msg || 'Starting container...',
    active:       'Live',
    error:        msg || 'Error',
  };
  return (
    <span className={`status-pill ${state}`}>
      <span className="status-dot" />
      {labels[state]}
    </span>
  );
}

interface StreamViewProps {
  sessionState: SessionState;
  statusMsg:    string;
  fps:          number;
  send:         (msg: object) => void;
  setOnFrame:   (cb: (data: string) => void) => void;
  setOnUrlChange: (cb: (url: string) => void) => void;
  onStop:       () => void;
}

function StreamView({ sessionState, statusMsg, fps, send, setOnFrame, setOnUrlChange, onStop }: StreamViewProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [url, setUrl] = useState('https://google.com');

  useEffect(() => {
    setOnFrame((base64: string) => {
      if (imgRef.current) {
        imgRef.current.src = 'data:image/jpeg;base64,' + base64;
      }
    });
  }, [setOnFrame]);

  // Keep the URL bar in sync when the remote browser navigates (clicked links, redirects)
  useEffect(() => {
    setOnUrlChange((newUrl: string) => {
      setUrl(newUrl);
    });
  }, [setOnUrlChange]);

  // Compute normalized (0–1) coordinates that account for CSS object-fit:contain
  // letterboxing. The <img> element box may be wider/taller than the actual
  // rendered image pixels — clicks in the black bars must be clamped so they
  // don't map outside the Chromium viewport (1280×720).
  const getImageCoords = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const el   = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const elW  = rect.width;
    const elH  = rect.height;

    // Intrinsic image size (matches VIEWPORT in container: 1280×720).
    // Falls back to element size before the first frame arrives.
    const imgW = el.naturalWidth  || elW;
    const imgH = el.naturalHeight || elH;

    // Scale factor used by object-fit:contain (uniform, letterbox)
    const scale  = Math.min(elW / imgW, elH / imgH);
    const rendW  = imgW * scale;
    const rendH  = imgH * scale;
    const offX   = (elW - rendW) / 2;   // horizontal black bar width
    const offY   = (elH - rendH) / 2;   // vertical black bar height

    // Clamp so clicks in the black bars map to the nearest edge pixel
    const cx = Math.max(0, Math.min(e.clientX - rect.left - offX, rendW));
    const cy = Math.max(0, Math.min(e.clientY - rect.top  - offY, rendH));

    return { x: cx / rendW, y: cy / rendH };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (sessionState !== 'active') return;
    const { x, y } = getImageCoords(e);
    send({ type: 'click', x, y });
  }, [sessionState, send, getImageCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (sessionState !== 'active') return;
    const { x, y } = getImageCoords(e);
    send({ type: 'mousemove', x, y });
  }, [sessionState, send, getImageCoords]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (sessionState !== 'active') return;
    const { x, y } = getImageCoords(e as unknown as React.MouseEvent<HTMLImageElement>);
    send({ type: 'scroll', x, y, deltaY: e.deltaY });
  }, [sessionState, send, getImageCoords]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sessionState !== 'active') return;
      // Only suppress forwarding when the user is typing in the LOCAL url bar.
      // Previously this checked tagName === 'INPUT' which also blocked keys
      // after clicking the stream image if focus drifted to any input element.
      if ((e.target as HTMLElement).id === 'url-input') return;
      e.preventDefault();
      if (e.key.length === 1) {
        send({ type: 'type', text: e.key });
      } else {
        send({ type: 'keydown', key: e.key });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionState, send]);

  const navigate = useCallback(() => send({ type: 'navigate', url }), [send, url]);
  const goBack    = useCallback(() => send({ type: 'back' }),           [send]);
  const goForward = useCallback(() => send({ type: 'forward' }),        [send]);
  const reload    = useCallback(() => send({ type: 'reload' }),         [send]);
  const isBooting = sessionState === 'connecting' || sessionState === 'booting' || sessionState === 'reconnecting';

  return (
    <div className="stream-page">
      <div className="topbar">
        <span className="topbar-logo">browse</span>
        <StatusPill state={sessionState} msg={statusMsg} />
        <span className="topbar-spacer" />
        <span className="fps-badge">{sessionState === 'active' ? `${fps} fps` : ''}</span>
        <button className="end-btn" onClick={onStop} id="end-session-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
          </svg>
          End Session
        </button>
      </div>

      <div className="urlbar">
        {/* Navigation cluster: back / forward / reload */}
        <div className="nav-cluster">
          <button
            id="nav-back-btn"
            className="nav-btn"
            onClick={goBack}
            disabled={isBooting || sessionState !== 'active'}
            title="Back"
            aria-label="Go back"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            id="nav-forward-btn"
            className="nav-btn"
            onClick={goForward}
            disabled={isBooting || sessionState !== 'active'}
            title="Forward"
            aria-label="Go forward"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button
            id="nav-reload-btn"
            className="nav-btn"
            onClick={reload}
            disabled={isBooting || sessionState !== 'active'}
            title="Reload"
            aria-label="Reload page"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <input
          id="url-input"
          className="urlbar-input"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(); }}
          placeholder="https://..."
          disabled={isBooting}
          spellCheck={false}
        />
        <button
          id="navigate-btn"
          className="urlbar-btn"
          onClick={navigate}
          disabled={isBooting}
        >
          Go
        </button>
      </div>

      <div className="stream-area">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          className="stream-img"
          alt="Remote browser stream"
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onWheel={handleWheel}
          draggable={false}
          id="stream-img"
        />

        {isBooting && (
          <div className="booting-overlay animate-in">
            <div className="spinner" />
            <p className="booting-text">{statusMsg || 'Starting...'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const { sessionState, statusMsg, fps, connect, disconnect, send, setOnFrame, setOnUrlChange } =
    useRemoteBrowser();

  const isStreaming = sessionState !== 'idle';

  return (
    <main>
      {!isStreaming ? (
        <LandingView onStart={connect} />
      ) : (
        <StreamView
          sessionState={sessionState}
          statusMsg={statusMsg}
          fps={fps}
          send={send}
          setOnFrame={setOnFrame}
          setOnUrlChange={setOnUrlChange}
          onStop={disconnect}
        />
      )}
    </main>
  );
}
