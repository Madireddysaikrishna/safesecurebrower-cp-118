'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

export type SessionState = 'idle' | 'connecting' | 'reconnecting' | 'booting' | 'active' | 'error';

export interface RemoteBrowserState {
  sessionState: SessionState;
  statusMsg:    string;
  fps:          number;
}

export interface RemoteBrowserActions {
  connect:    () => void;
  disconnect: () => void;
  send:       (msg: object) => void;
  setOnFrame: (cb: (data: string) => void) => void;
  setOnUrlChange: (cb: (url: string) => void) => void;
}

const WS_URL            = process.env.NEXT_PUBLIC_BACKEND_URL || 'ws://localhost:3000';
const SESSION_STORAGE_KEY = 'safebrowser_session_id';

export function useRemoteBrowser(): RemoteBrowserState & RemoteBrowserActions {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [statusMsg, setStatusMsg]       = useState('');
  const [fps, setFps]                   = useState(0);

  const wsRef           = useRef<WebSocket | null>(null);
  const frameCountRef   = useRef(0);
  const onFrameRef      = useRef<((data: string) => void) | null>(null);
  const onUrlChangeRef  = useRef<((url: string) => void) | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const connect = useCallback(() => {
    // Guard: already connecting or active
    if (wsRef.current) return;
    if (sessionState !== 'idle' && sessionState !== 'error') return;

    const storedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    const isReconnect     = !!storedSessionId;

    setSessionState(isReconnect ? 'reconnecting' : 'connecting');
    setStatusMsg(isReconnect ? 'Resuming your session...' : 'Connecting to backend...');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type:      'hello',
        sessionId: storedSessionId ?? null,
      }));
      if (!isReconnect) {
        setSessionState('booting');
        setStatusMsg('Starting Docker container...');
      }
    };

    ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      switch (msg.type) {
        case 'frame':
          frameCountRef.current++;
          onFrameRef.current?.(msg.data as string);
          break;

        case 'url_changed':
          onUrlChangeRef.current?.(msg.url as string);
          break;

        case 'status':
          if (msg.message === 'container_starting') {
            setSessionState('booting');
            setStatusMsg('Launching Chromium in container...');
          } else if (msg.message === 'session_ready') {
            localStorage.setItem(SESSION_STORAGE_KEY, msg.sessionId);
            setSessionState('active');
            setStatusMsg('');
          } else if (msg.message === 'session_resumed') {
            setSessionState('active');
            setStatusMsg('Session resumed');
            setTimeout(() => setStatusMsg(''), 2500);
          } else if (msg.message === 'session_expired') {
            localStorage.removeItem(SESSION_STORAGE_KEY);
            setSessionState('booting');
            setStatusMsg('Previous session expired. Starting fresh...');
          } else if (msg.message === 'container_closed') {
            localStorage.removeItem(SESSION_STORAGE_KEY);
            setSessionState('idle');
            setStatusMsg('');
          }
          break;

        case 'error':
          setSessionState('error');
          setStatusMsg(msg.message as string);
          break;
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Only reset to idle if we weren't already set to error by onerror.
      // This prevents the landing page re-render from triggering a new connect cycle.
      setSessionState((prev) => (prev === 'error' ? 'idle' : 'idle'));
      setStatusMsg('');
    };

    ws.onerror = () => {
      // Clear stale session so the next connect attempt starts fresh.
      // Without this, the old session ID is re-sent → backend responds
      // 'session_expired' → state goes to 'booting' → container launch
      // fails → error → onclose → idle → user clicks again → infinite loop.
      localStorage.removeItem(SESSION_STORAGE_KEY);
      setSessionState('error');
      setStatusMsg('Cannot connect to backend. Is `node server.js` running in backend/?');
      wsRef.current = null;
    };
  }, [sessionState]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    wsRef.current?.close();
    wsRef.current = null;
    setSessionState('idle');
    setStatusMsg('');
  }, []);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const setOnFrame = useCallback((cb: (data: string) => void) => {
    onFrameRef.current = cb;
  }, []);

  const setOnUrlChange = useCallback((cb: (url: string) => void) => {
    onUrlChangeRef.current = cb;
  }, []);

  return { sessionState, statusMsg, fps, connect, disconnect, send, setOnFrame, setOnUrlChange };
}
