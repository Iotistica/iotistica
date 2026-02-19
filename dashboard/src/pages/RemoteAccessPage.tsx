import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Terminal as TerminalIcon, Power, Plus, Settings } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import { buildApiUrl } from '@/config/api';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useAuth } from '@/contexts/AuthContext';

interface SessionInfo {
  sessionId: string;
  deviceUuid: string;
  userId: string;
  status: 'creating' | 'active' | 'detached' | 'terminated';
  createdAt: string;
  lastActivity: string;
}

interface RemoteAccessPageProps {
  deviceUuid: string;
}

export function RemoteAccessPage({ deviceUuid }: RemoteAccessPageProps) {
  console.log('[RemoteAccess] Component rendered with deviceUuid:', deviceUuid);
  
  const { user } = useAuth();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isDisconnectingRef = useRef(false); // Track intentional disconnects
  const autoConnectPendingRef = useRef<boolean>(false);
  const currentSessionIdRef = useRef<string | null>(null);
  const currentDeviceUuidRef = useRef<string>(deviceUuid); // Track which device the current session belongs to
  const isAttachingRef = useRef<boolean>(false); // Prevent race conditions during session switching
  const isNewSessionRef = useRef<boolean>(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [ptyRestarted, setPtyRestarted] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<{status: string; message: string} | null>(null);
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem('terminal-font-size');
    return saved ? parseInt(saved, 10) : 14;
  });
  
  // Helper functions for persistent session storage (survives component unmount)
  const saveSessionState = (deviceId: string, sessionId: string, sessionsList: SessionInfo[]) => {
    try {
      const key = `remote-session-${deviceId}`;
      const state = { sessionId, sessions: sessionsList, timestamp: Date.now() };
      sessionStorage.setItem(key, JSON.stringify(state));
      console.log('[RemoteAccess] Saved session state to sessionStorage:', key, state);
    } catch (error) {
      console.error('[RemoteAccess] Failed to save session state:', error);
    }
  };
  
  const loadSessionState = (deviceId: string): { sessionId: string; sessions: SessionInfo[] } | null => {
    try {
      const key = `remote-session-${deviceId}`;
      const stored = sessionStorage.getItem(key);
      if (!stored) {
        console.log('[RemoteAccess] No stored session state for:', key);
        return null;
      }
      const state = JSON.parse(stored);
      // Expire after 1 hour
      if (Date.now() - state.timestamp > 3600000) {
        console.log('[RemoteAccess] Session state expired for:', key);
        sessionStorage.removeItem(key);
        return null;
      }
      console.log('[RemoteAccess] Loaded session state from sessionStorage:', key, state);
      return { sessionId: state.sessionId, sessions: state.sessions };
    } catch (error) {
      console.error('[RemoteAccess] Failed to load session state:', error);
      return null;
    }
  };

  const connectWebSocket = (skipAutoConnect = false) => {
    console.log('[RemoteAccess] 🔌 connectWebSocket() called - skipAutoConnect:', skipAutoConnect, '- STACK TRACE:');
    console.trace();
    console.log('[RemoteAccess] Current WS state:', wsRef.current?.readyState);
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[RemoteAccess] WebSocket already open, skipping');
      return;
    }
    
    setIsConnecting(true);
    console.log('[RemoteAccess] 🔌 Creating new WebSocket connection...');
    
    const wsUrl = buildApiUrl(`/ws?deviceUuid=${deviceUuid}`).replace(/^http/, 'ws');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[RemoteAccess] ✅ WebSocket OPENED');
      setIsConnected(true);
      setIsConnecting(false);
      
      // Subscribe to shell channel
      console.log('[RemoteAccess] ✅ Subscribing to shell channel');
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'shell',
      }));

      if (xtermRef.current) {
        xtermRef.current.writeln('\x1b[32m✓ Connected to WebSocket\x1b[0m');
      }

      // Auto-connect: List existing sessions (unless reconnecting to saved session)
      if (!skipAutoConnect) {
        console.log('[RemoteAccess] ✅ Sending list-sessions and ENABLING auto-connect');
        ws.send(JSON.stringify({
          type: 'list-sessions',
          deviceUuid,
        }));
        autoConnectPendingRef.current = true;
        console.log('[RemoteAccess] ✅ autoConnectPendingRef.current = true');
      } else {
        console.log('[RemoteAccess] ⏭️ Skipping auto-connect (reconnecting to saved session)');
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (error) {
        console.error('[RemoteAccess] Error parsing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('[RemoteAccess] WebSocket error:', error);
      setIsConnected(false);
      setIsConnecting(false);
      if (xtermRef.current) {
        xtermRef.current.writeln('\r\n\x1b[31m✗ Connection error\x1b[0m');
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsConnecting(false);
      // Only show unexpected disconnect message
      if (!isDisconnectingRef.current && xtermRef.current) {
        xtermRef.current.writeln('\r\n\x1b[31m✗ Connection lost\x1b[0m');
      }
      isDisconnectingRef.current = false;
    };
  };

  const handleWebSocketMessage = (message: any) => {
    switch (message.type) {
      case 'session-created':
        console.log('[RemoteAccess] 🆕 Received session-created for:', message.sessionId?.substring(0, 8));
        if (xtermRef.current) {
          xtermRef.current.writeln('\x1b[32m✓ Session created\x1b[0m');
        }
        // Auto-attach to newly created session
        console.log('[RemoteAccess] 🆕 Auto-attaching to newly created session');
        if (wsRef.current && message.sessionId) {
          wsRef.current.send(JSON.stringify({
            type: 'attach-session',
            data: { 
              sessionId: message.sessionId,
              userId: user?.id,
            },
          }));
        }
        break;

      case 'session-attached': {
        console.log('[RemoteAccess] 📨 Received session-attached for:', message.sessionId?.substring(0, 8), '- PTY restarted:', message.data?.ptyRestarted || message.ptyRestarted);
        
        // Clear the attaching flag
        isAttachingRef.current = false;
        
        setCurrentSessionId(message.sessionId);
        currentSessionIdRef.current = message.sessionId;
        currentDeviceUuidRef.current = deviceUuid; // Track which device this session belongs to
        
        // Save session state immediately when attached
        console.log('[RemoteAccess] Saving session state immediately after attach');
        saveSessionState(deviceUuid, message.sessionId, sessions);
        
        // Check for PTY restart (nested under data)
        const ptyWasRestarted = message.data?.ptyRestarted || message.ptyRestarted;
        if (ptyWasRestarted) {
          setPtyRestarted(true);
        }

        if (xtermRef.current) {
          xtermRef.current.clear();
          xtermRef.current.writeln('\x1b[32m✓ Attached to session\x1b[0m');
          
          // Display buffered output (check both data.buffer and buffer for compatibility)
          const buffer = message.data?.buffer || message.buffer;
          
          // For brand new sessions, skip buffer replay - PTY is still active and will send fresh output
          // Only replay buffer if it contains actual command history (not just startup banner + first prompt)
          const isJustStartupBanner = buffer && buffer.length <= 2 && 
            buffer.some((chunk: string) => chunk.includes('Shell session started'));
          
          // Only replay buffer if:
          // 1. PTY wasn't restarted (would have stale data)
          // 2. Buffer has meaningful history (not just startup)
          if (buffer && buffer.length > 0 && !ptyWasRestarted && !isJustStartupBanner) {
            buffer.forEach((chunk: string) => {
              xtermRef.current?.write(chunk);
            });
            
            // Only send \r if buffer doesn't already end with a prompt
            const lastChunk = buffer[buffer.length - 1];
            const hasPrompt = /[$#]\s*$/.test(lastChunk);
            
            if (isNewSessionRef.current && !hasPrompt && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'shell-input',
                data: {
                  sessionId: message.sessionId,
                  input: '\r',
                },
              }));
            }
          } else if (( !buffer || buffer.length === 0 || isJustStartupBanner) && isNewSessionRef.current) {
            // For freshly created sessions only, write a newline to establish cursor position
            xtermRef.current.write('\r\n');
          }
          
          // Focus terminal so user can start typing immediately
          xtermRef.current.focus();
        }

        // Send terminal size to backend for proper PTY configuration
        resizeSession();

        // Clear new-session flag after attach handling
        isNewSessionRef.current = false;

        // Refresh session list
        listSessions();
        break;
      }

      case 'session-detached':
        setCurrentSessionId(null);
        currentSessionIdRef.current = null;
        if (xtermRef.current) {
          xtermRef.current.writeln('\r\n\x1b[33m⚠ Session detached\x1b[0m');
        }
        listSessions();
        break;

      case 'session-terminated':
        console.log('[RemoteAccess] Received session-terminated message for:', message.sessionId?.substring(0, 8), 'current:', currentSessionId?.substring(0, 8));
        if (message.sessionId === currentSessionId) {
          setCurrentSessionId(null);
          currentSessionIdRef.current = null;
        }
        if (xtermRef.current) {
          // Ensure clean newlines to avoid overlapping command output like 'top'
          xtermRef.current.write('\r\n');
          xtermRef.current.writeln('\x1b[33m✓ Session terminated\x1b[0m');
        }
        listSessions();
        break;

      case 'session-status':
        console.log('[RemoteAccess] 📊 Received session-status:', message.data?.status, message.data?.message);
        setSessionStatus({
          status: message.data?.status,
          message: message.data?.message,
        });
        
        // Clear status when session becomes active
        if (message.data?.status === 'active') {
          setTimeout(() => setSessionStatus(null), 2000); // Clear after 2 seconds
        }
        break;

      case 'all-sessions-cleared':
        console.log('[RemoteAccess] 🗑️ ALL SESSIONS CLEARED - Server confirmed:', message.message);
        console.log('[RemoteAccess] 🗑️ Clearing local state...');
        
        // Disable auto-connect to prevent duplicate session creation
        autoConnectPendingRef.current = false;
        
        setCurrentSessionId(null);
        currentSessionIdRef.current = null;
        setSessions([]);
        if (xtermRef.current) {
          xtermRef.current.clear();
          xtermRef.current.writeln('\x1b[32m✓ All sessions cleared successfully!\x1b[0m');
          xtermRef.current.writeln('\x1b[90mCreating new session...\x1b[0m');
        }
        // Create a fresh new session after clearing
        console.log('[RemoteAccess] 🗑️ Will create new session in 500ms...');
        setTimeout(() => {
          console.log('[RemoteAccess] 🗑️ Creating new session NOW');
          createNewSession();
        }, 500);
        break;

      case 'sessions-list':
        console.log('[RemoteAccess] 📋 Received sessions-list');
        const sessionsList = message.data?.sessions || message.sessions || [];
        console.log('[RemoteAccess] 📋 Total sessions from backend:', sessionsList.length);
        console.log('[RemoteAccess] 📋 ALL sessions from backend:', sessionsList.map((s: SessionInfo) => ({
          id: s.sessionId.substring(0, 8),
          status: s.status,
          userId: s.userId,
          deviceUuid: s.deviceUuid.substring(0, 8),
        })));
        // Filter to show only creating/active sessions (exclude detached and terminated)
        // Also filter by current user when available to avoid cross-user attach errors
        const currentUserId = user?.id !== undefined && user?.id !== null
          ? String(user.id)
          : null;
        console.log('[RemoteAccess] 📋 Current userId for filtering:', currentUserId);
        const usableSessions = sessionsList.filter((s: SessionInfo) => {
          // Only show sessions that are actively in use (not detached or terminated)
          const isUsableStatus = s.status === 'creating' || s.status === 'active';
          if (!isUsableStatus) {
            return false;
          }
          if (!currentUserId) {
            return true;
          }
          if (!s.userId) {
            return true;
          }
          return String(s.userId) === currentUserId;
        });
        console.log('[RemoteAccess] 📋 Usable sessions after filtering:', usableSessions.length, usableSessions.map((s: SessionInfo) => ({id: s.sessionId.substring(0, 8), status: s.status})));
        setSessions(usableSessions);
        
        // Auto-connect logic: attach to most recent active/detached session OR create new
        console.log('[RemoteAccess] 🤖 Auto-connect check - autoConnectPendingRef:', autoConnectPendingRef.current, 'currentSessionId:', currentSessionIdRef.current?.substring(0, 8));
        
        // SAFETY: Only run auto-connect if:
        // 1. autoConnectPendingRef is true
        // 2. We DON'T already have a current session (prevents creating duplicates during session switch)
        if (autoConnectPendingRef.current && !currentSessionIdRef.current) {
          console.log('[RemoteAccess] 🤖 Auto-connect IS ACTIVE - processing...');
          autoConnectPendingRef.current = false;
          
          if (!user?.id) {
            console.log('[RemoteAccess] User not ready yet, deferring auto-connect');
            autoConnectPendingRef.current = true;
            return;
          }
          
          // Filter for active sessions only (creating sessions aren't ready to attach)
          const existingSessions = usableSessions.filter((s: SessionInfo) =>
            s.status === 'active'
          );
          
          if (existingSessions.length > 0) {
            // Attach to most recent session
            const mostRecent = existingSessions.sort((a: SessionInfo, b: SessionInfo) => 
              new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
            )[0];
            
            if (xtermRef.current) {
              xtermRef.current.writeln(`\x1b[90mAttaching to existing session...\x1b[0m`);
            }
            
            if (wsRef.current) {
              wsRef.current.send(JSON.stringify({
                type: 'attach-session',
                data: { 
                  sessionId: mostRecent.sessionId,
                  userId: user?.id,
                },
              }));
            }
          } else {
            // Create new session
            console.log('[RemoteAccess] 🤖 No existing sessions found - creating new session');
            if (xtermRef.current) {
              xtermRef.current.writeln(`\x1b[90mCreating new session...\x1b[0m`);
            }
            createNewSession();
          }
        }
        break;

      case 'shell-output':
        console.log('[RemoteAccess] shell-output received, sessionId:', message.sessionId?.substring(0, 8), 'current:', currentSessionIdRef.current?.substring(0, 8), 'hasOutput:', !!message.data?.output);
        // Accept output if sessionId matches OR if sessionId is null (legacy agent messages)
        if (message.data?.output && (message.sessionId === currentSessionIdRef.current || !message.sessionId)) {
          console.log('[RemoteAccess] Writing output to terminal:', message.data.output.length, 'chars');
          if (xtermRef.current) {
            xtermRef.current.write(message.data.output);
          }
          // Clear PTY restart warning on first output
          if (ptyRestarted) {
            setPtyRestarted(false);
          }
        } else {
          console.warn('[RemoteAccess] shell-output NOT displayed. Session match:', message.sessionId === currentSessionIdRef.current, 'Has output:', !!message.data?.output, 'SessionId:', message.sessionId);
        }
        break;

      case 'shell':
        // Legacy shell output format (type: 'shell', data: { output: '...' })
        if (message.data?.output) {
          if (xtermRef.current) {
            xtermRef.current.write(message.data.output);
          }
          // Clear PTY restart warning on first output
          if (ptyRestarted) {
            setPtyRestarted(false);
          }
        }
        break;

      case 'error':
        const errorMsg = message.error || message.message || JSON.stringify(message);
        console.error('[RemoteAccess] Server error:', errorMsg);
        
        // If error is about session not found or access denied, clear stale sessionStorage and create new session
        if (
          (errorMsg.includes('Session') && errorMsg.includes('not found')) ||
          errorMsg.includes('Access denied') ||
          errorMsg.includes('has been terminated')
        ) {
          console.warn('[RemoteAccess] Session invalid - clearing stale sessionStorage');
          try {
            sessionStorage.removeItem(`remote-session-${deviceUuid}`);
            setCurrentSessionId(null);
            currentSessionIdRef.current = null;
          } catch (e) {
            console.error('[RemoteAccess] Failed to clear sessionStorage:', e);
          }
          if (xtermRef.current) {
            xtermRef.current.writeln(`\r\n\x1b[31m✗ ${errorMsg}\x1b[0m`);
            xtermRef.current.writeln('\x1b[90mCreating new session...\x1b[0m');
          }
          // Auto-create a new session
          createNewSession();
        } else if (xtermRef.current) {
          xtermRef.current.writeln(`\r\n\x1b[31m✗ Error: ${errorMsg}\x1b[0m`);
        }
        break;

      default:
        break;
    }
  };

  const createNewSession = () => {
    console.log('[RemoteAccess] ✨ createNewSession() called');
    console.log('[RemoteAccess] ✨ Current state - currentSessionId:', currentSessionIdRef.current?.substring(0, 8), 'autoConnectPending:', autoConnectPendingRef.current, 'isAttaching:', isAttachingRef.current);
    console.log('[RemoteAccess] ✨ STACK TRACE:');
    console.trace();
    
    // SAFETY: Don't create a new session if we're in the middle of attaching to one
    // (prevents accidental duplication during session switching)
    if (isAttachingRef.current) {
      console.log('[RemoteAccess] ⚠️ BLOCKED: Currently attaching to a session - not creating duplicate');
      return;
    }
    
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[RemoteAccess] WebSocket not connected');
      return;
    }

    console.log('[RemoteAccess] ✨ Sending create-session message to backend');
    isNewSessionRef.current = true;
    const msg = {
      type: 'create-session',
      deviceUuid,
      data: {
        userId: user?.id,
      },
    };
    wsRef.current.send(JSON.stringify(msg));

    if (xtermRef.current) {
      xtermRef.current.writeln('\x1b[90mCreating new session...\x1b[0m');
    }
  };

  // COMMENTED OUT: Unused after UI simplification - keeping for reference
  // const attachToSession = (sessionId: string) => {
  //   console.log('[RemoteAccess] 🔄 attachToSession called for:', sessionId.substring(0, 8));
  //   
  //   // Prevent race conditions - don't allow multiple simultaneous attach operations
  //   if (isAttachingRef.current) {
  //     console.log('[RemoteAccess] ⚠️ BLOCKED: Already attaching to a session, ignoring duplicate call');
  //     return;
  //   }
  //   
  //   if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
  //     console.error('[RemoteAccess] WebSocket not connected');
  //     return;
  //   }
  //
  //   if (!sessionId) {
  //     console.error('[RemoteAccess] Cannot attach - sessionId is null/undefined');
  //     return;
  //   }
  //   
  //   // Mark that we're in the process of attaching
  //   isAttachingRef.current = true;
  //   
  //   // Disable auto-connect to prevent creating new session when listSessions is called
  //   autoConnectPendingRef.current = false;
  //   console.log('[RemoteAccess] 🔄 Auto-connect disabled for manual session switch');
  //   
  //   // Don't call detachFromSession when switching - just attach to new session
  //   // Backend will handle moving client from old session to new one
  //   
  //   const msg = {
  //     type: 'attach-session',
  //     data: { 
  //       sessionId,
  //       userId: user?.id,
  //     },
  //   };
  //   wsRef.current.send(JSON.stringify(msg));
  //   console.log('[RemoteAccess] 🔄 Sent attach-session message');
  //
  //   if (xtermRef.current) {
  //     xtermRef.current.clear();
  //     xtermRef.current.writeln(`\x1b[90mSwitching to session ${sessionId.substring(0, 8)}...\x1b[0m`);
  //   }
  // };

  const detachFromSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !currentSessionId) {
      return;
    }

    const msg = {
      type: 'detach-session',
      data: { sessionId: currentSessionId },
    };
    wsRef.current.send(JSON.stringify(msg));
  };

  const terminateSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !currentSessionIdRef.current) {
      return;
    }

    console.log('[RemoteAccess] Terminating session:', currentSessionIdRef.current.substring(0, 8));
    const msg = {
      type: 'terminate-session',
      data: { sessionId: currentSessionIdRef.current },
    };
    wsRef.current.send(JSON.stringify(msg));
  };


  const listSessions = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const msg = {
      type: 'list-sessions',
      deviceUuid,
    };
    wsRef.current.send(JSON.stringify(msg));
  };

  const sendInput = (data: string) => {
    console.log('[RemoteAccess] sendInput called, WS state:', wsRef.current?.readyState, 'Session:', currentSessionIdRef.current?.substring(0, 8));
    
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[RemoteAccess] sendInput blocked - WebSocket not open');
      return;
    }

    if (!currentSessionIdRef.current) {
      console.warn('[RemoteAccess] sendInput blocked - No session ID');
      return;
    }

    const msg = {
      type: 'shell-input',
      data: {
        sessionId: currentSessionIdRef.current,
        input: data,
      },
    };
    console.log('[RemoteAccess] Sending shell-input message:', msg);
    wsRef.current.send(JSON.stringify(msg));
  };

  const resizeSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!currentSessionIdRef.current || !xtermRef.current) {
      return;
    }

    const { cols, rows } = xtermRef.current;
    const msg = {
      type: 'resize-session',
      data: {
        sessionId: currentSessionIdRef.current,
        cols,
        rows,
      },
    };
    wsRef.current.send(JSON.stringify(msg));
  };

  const disconnect = () => {
    console.log('[RemoteAccess] disconnect() called, currentSessionId:', currentSessionId, 'currentSessionIdRef:', currentSessionIdRef.current);
    console.log('[RemoteAccess] Current device:', deviceUuid, 'Session belongs to device:', currentDeviceUuidRef.current);
    if (wsRef.current) {
      // Terminate session when disconnect button clicked (clean break)
      // Browser navigation/unmount will detach (allowing reconnect)
      const sessionId = currentSessionIdRef.current || currentSessionId;
      if (sessionId) {
        console.log('[RemoteAccess] Terminating session (disconnect button)');
        if (xtermRef.current) {
          // Ensure clean line breaks to avoid overlapping active command output
          xtermRef.current.write('\r\n');
          xtermRef.current.writeln('\x1b[90mClosing session...\x1b[0m');
        }
        terminateSession();
        // Clear session from sessionStorage - user wants to disconnect
        sessionStorage.removeItem(`remote-session-${currentDeviceUuidRef.current}`);
      } else {
        console.log('[RemoteAccess] No current session to terminate');
      }
      
      // Mark as intentional disconnect to avoid "connection lost" message
      isDisconnectingRef.current = true;
      
      // Give the terminate message time to be sent AND the session-terminated response to be received
      // before closing WebSocket (needs 300+ ms for round-trip)
      setTimeout(() => {
        if (wsRef.current) {
          // Only send if WebSocket is still open
          if (wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'unsubscribe',
              channel: 'shell',
            }));
          }
          wsRef.current.close();
          wsRef.current = null;
        }
      }, 500); // 500ms delay to ensure terminate message is sent AND response is received
    }
    setIsConnected(false);
    setCurrentSessionId(null);
    currentSessionIdRef.current = null;
  };

  // Warn user before navigating away from active session
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Only warn if actually attached to a session (not just WebSocket connected)
      if (currentSessionIdRef.current) {
        e.preventDefault();
        e.returnValue = 'You have an active shell session. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize xterm.js
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
      },
      allowTransparency: true,
      disableStdin: false,
      // Explicitly disable local echo - server will echo back
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(terminalRef.current);
    fitAddon.fit();
    
    // Focus terminal immediately after opening
    term.focus();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle user input
    term.onData((data) => {
      console.log('[RemoteAccess] Terminal input received:', data.charCodeAt(0), 'WS state:', wsRef.current?.readyState, 'Session:', currentSessionIdRef.current?.substring(0, 8));
      
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.warn('[RemoteAccess] Cannot send input - WebSocket not open');
        return;
      }

      if (!currentSessionIdRef.current) {
        console.warn('[RemoteAccess] Cannot send input - No session attached');
        term.write('\x1b[31m✗ Not attached to a session\x1b[0m\r\n');
        return;
      }

      // Send all input directly (don't echo - server will echo back)
      console.log('[RemoteAccess] Sending input to session:', currentSessionIdRef.current.substring(0, 8));
      sendInput(data);
    });

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
      // Send new terminal size to backend
      resizeSession();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      console.log('[RemoteAccess] Terminal cleanup - component unmounting');
      console.log('[RemoteAccess] Current session at unmount:', currentSessionIdRef.current);
      
      // Save session state before cleanup
      if (currentSessionIdRef.current) {
        console.log('[RemoteAccess] Saving session state before unmount');
        // Use the device the session belongs to, not the current deviceUuid
        const key = `remote-session-${currentDeviceUuidRef.current}`;
        const state = { 
          sessionId: currentSessionIdRef.current, 
          sessions: [], // Sessions list will be fetched on reconnect
          timestamp: Date.now() 
        };
        sessionStorage.setItem(key, JSON.stringify(state));
        console.log('[RemoteAccess] Saved to sessionStorage during cleanup:', key, state);
        
        // Detach from session (allows reconnect) instead of terminating
        console.log('[RemoteAccess] Detaching from session for later reconnect');
        detachFromSession();
      }
      
      window.removeEventListener('resize', handleResize);
      
      // Close WebSocket and dispose terminal
      if (wsRef.current) {
        console.log('[RemoteAccess] Closing WebSocket on unmount');
        isDisconnectingRef.current = true; // Mark as intentional disconnect
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'unsubscribe',
            channel: 'shell',
          }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
      term.dispose();
    };
  }, []); // No dependencies - stable across session changes

  // Update font size dynamically without recreating terminal
  useEffect(() => {
    if (xtermRef.current && fitAddonRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      // Refit terminal to adjust layout for new font size
      fitAddonRef.current.fit();
    }
    // Save to localStorage
    localStorage.setItem('terminal-font-size', fontSize.toString());
  }, [fontSize]);

  // Keep session state updated whenever currentSessionId or sessions change
  useEffect(() => {
    if (currentSessionId && currentDeviceUuidRef.current) {
      console.log('[RemoteAccess] ===== SAVE EFFECT TRIGGERED =====');
      console.log('[RemoteAccess] currentSessionId:', currentSessionId);
      console.log('[RemoteAccess] currentDeviceUuidRef.current:', currentDeviceUuidRef.current);
      console.log('[RemoteAccess] deviceUuid prop:', deviceUuid);
      
      // Safety check: only save if session belongs to current device
      if (currentDeviceUuidRef.current === deviceUuid) {
        console.log('[RemoteAccess] Device matches, saving session state');
        saveSessionState(currentDeviceUuidRef.current, currentSessionId, sessions);
      } else {
        console.warn('[RemoteAccess] SKIPPING SAVE - Device mismatch! Session device:', currentDeviceUuidRef.current, 'Current device:', deviceUuid);
      }
    }
  }, [currentSessionId, sessions, deviceUuid]); // Added deviceUuid back for safety check

  // If auth loads after WebSocket is open, re-list sessions to complete auto-connect
  useEffect(() => {
    if (!user?.id || !autoConnectPendingRef.current) {
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log('[RemoteAccess] User ready - requesting sessions list for auto-connect');
    wsRef.current.send(JSON.stringify({
      type: 'list-sessions',
      deviceUuid,
    }));
  }, [user?.id, deviceUuid]);

  // Handle device switching - preserve and restore sessions
  useEffect(() => {
    console.log('[RemoteAccess] ===== DEVICE SWITCHING EFFECT START =====');
    console.log('[RemoteAccess] New deviceUuid:', deviceUuid);
    console.log('[RemoteAccess] currentDeviceUuidRef.current (old device):', currentDeviceUuidRef.current);
    console.log('[RemoteAccess] currentSessionId (state):', currentSessionId);
    console.log('[RemoteAccess] currentSessionIdRef.current (ref):', currentSessionIdRef.current);
    
    // Save and detach from previous device's session (if exists)
    if (currentSessionIdRef.current && currentDeviceUuidRef.current && currentDeviceUuidRef.current !== deviceUuid) {
      console.log('[RemoteAccess] Saving session for previous device:', currentDeviceUuidRef.current);
      saveSessionState(currentDeviceUuidRef.current, currentSessionIdRef.current, sessions);
      
      console.log('[RemoteAccess] Detaching from previous device session');
      detachFromSession();
    }
    
    // Clear session state immediately to prevent save effect from firing with wrong device
    console.log('[RemoteAccess] Clearing currentSessionId state...');
    setCurrentSessionId(null);
    
    // Close WebSocket from previous device
    if (wsRef.current) {
      console.log('[RemoteAccess] Closing WebSocket for previous device');
      isDisconnectingRef.current = true; // Mark as intentional disconnect
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'unsubscribe',
          channel: 'shell',
        }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    
    // Now update the current device ref to the new device
    console.log('[RemoteAccess] Updating currentDeviceUuidRef from', currentDeviceUuidRef.current, 'to', deviceUuid);
    currentDeviceUuidRef.current = deviceUuid;
    
    // Check if we have a saved session for this NEW device
    const savedState = loadSessionState(deviceUuid);
    console.log('[RemoteAccess] Saved state for this device:', savedState);
    
    if (xtermRef.current) {
      xtermRef.current.clear();
      
      if (savedState?.sessionId) {
        console.log('[RemoteAccess] Found saved session, will reconnect to:', savedState.sessionId);
        xtermRef.current.writeln('\x1b[33m↻ Reconnecting to previous session...\x1b[0m');
      } else {
        console.log('[RemoteAccess] No saved session found');
        xtermRef.current.writeln('\x1b[33mClick "Connect" to start a shell session\x1b[0m');
      }
    }
    
    // Restore saved sessions list
    if (savedState) {
      setSessions(savedState.sessions);
    } else {
      setSessions([]);
    }
    
    // Auto-reconnect to previous session
    if (savedState?.sessionId) {
      // Store the session ID to reconnect to
      const sessionToReconnect = savedState.sessionId;
      console.log('[RemoteAccess] Starting auto-reconnect sequence for session:', sessionToReconnect);
      
      // Connect WebSocket first (with auto-connect DISABLED to prevent race condition)
      connectWebSocket(true); // Pass true to skip auto-connect logic
      
      // Wait for WebSocket to establish, then reconnect
      const reconnectTimer = setTimeout(() => {
        console.log('[RemoteAccess] Reconnect timer fired, WS state:', wsRef.current?.readyState);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          console.log('[RemoteAccess] Sending attach-session message for:', sessionToReconnect);
          wsRef.current.send(JSON.stringify({
            type: 'attach-session',
            data: { 
              sessionId: sessionToReconnect,
              userId: user?.id,
            },
          }));
        } else {
          console.log('[RemoteAccess] WebSocket not ready, auto-reconnect failed');
        }
      }, 500);
      
      return () => clearTimeout(reconnectTimer);
    }
  }, [deviceUuid, user]);

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6 min-h-full flex flex-col">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground mb-2">Remote Access</h2>
          <p className="text-muted-foreground">
            Execute commands and manage your device remotely
          </p>
        </div>

        <Card className="border-2 flex flex-col flex-1 min-h-[calc(100vh-280px)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TerminalIcon className="h-5 w-5 text-muted-foreground" />
                <span className="font-semibold">
                  Shell Terminal
                  {currentSessionId && (
                    <span className="text-muted-foreground font-normal ml-2">
                      (id: {currentSessionId.substring(0, 8)})
                    </span>
                  )}
                </span>
              </div>
              
              <div className="flex items-center gap-2">
                {/* Connection Status */}
                <Badge 
                  variant={isConnected ? "default" : "secondary"}
                  className={isConnected ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'}
                >
                  {isConnecting ? 'Connecting...' : isConnected ? 'Connected' : 'Disconnected'}
                </Badge>
                
                {/* Connect/Disconnect Button */}
                {!isConnected ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => connectWebSocket()}
                    disabled={isConnecting}
                  >
                    <Power className="h-4 w-4 mr-1" />
                    Connect
                  </Button>
                ) : (
                  <>
                    {/* New Session Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={createNewSession}
                      className="cursor-pointer hover:bg-accent"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      New Session
                    </Button>

                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={disconnect}
                      className="cursor-pointer"
                    >
                      <Power className="h-4 w-4 mr-1" />
                      Disconnect
                    </Button>
                  </>
                )}

                {/* Settings Button - placed at far right */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" title="Terminal Settings">
                      <Settings className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64" align="end">
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-medium text-sm mb-3">Terminal Settings</h4>
                        <div className="space-y-2">
                          <Label className="text-sm text-muted-foreground">Font size</Label>
                          <div className="space-y-1">
                            <Button
                              variant={fontSize === 12 ? "default" : "ghost"}
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => setFontSize(12)}
                            >
                              Small
                            </Button>
                            <Button
                              variant={fontSize === 14 ? "default" : "ghost"}
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => setFontSize(14)}
                            >
                              Medium (default)
                            </Button>
                            <Button
                              variant={fontSize === 16 ? "default" : "ghost"}
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => setFontSize(16)}
                            >
                              Large
                            </Button>
                            <Button
                              variant={fontSize === 18 ? "default" : "ghost"}
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => setFontSize(18)}
                            >
                              Extra Large
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </CardHeader>

          <CardContent className="flex-1 overflow-hidden p-6">
            {/* Session Status Bar */}
            {sessionStatus && (
              <div className={`mb-4 p-3 rounded-lg border text-sm ${
                sessionStatus.status === 'starting' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                sessionStatus.status === 'active' ? 'bg-green-50 border-green-200 text-green-700' :
                sessionStatus.status === 'agent-timeout' ? 'bg-yellow-50 border-yellow-200 text-yellow-700' :
                'bg-gray-50 border-gray-200 text-gray-700'
              }`}>
                {sessionStatus.message}
              </div>
            )}
            
            {/* Terminal Container */}
            <div 
              ref={terminalRef}
              className="rounded-lg"
              style={{ 
                height: 'calc(100vh - 450px)',
                minHeight: '400px',
              }}
            />
          </CardContent>
        </Card>

        {/* Info and Quick Reference Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="border">
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground space-y-2">
                <p><strong>Keyboard Shortcuts:</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li><kbd>Enter</kbd> - Execute command</li>
                  <li><kbd>Ctrl+C</kbd> - Interrupt current process</li>
                  <li><kbd>Backspace</kbd> - Delete character</li>
                </ul>
                <p className="mt-4"><strong>Session Info:</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>Sessions persist across page navigation</li>
                  <li>Disconnect keeps session alive - reconnect to resume</li>
                  <li>Sessions auto-terminate after 30min of inactivity</li>
                  <li>Use sessions dropdown to switch between multiple sessions</li>
                </ul>
                <p className="mt-4"><strong>Note:</strong> For advanced SSH features (file transfer, tunneling), use VPN + native SSH client.</p>
              </div>
            </CardContent>
          </Card>

          <Card className="border">
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground space-y-2">
                <p><strong>Quick Command Reference:</strong></p>
                <div className="space-y-3 mt-2">
                  <div>
                    <p className="font-medium text-foreground mb-1">Device Status & Info</p>
                    <ul className="list-disc list-inside space-y-0.5 ml-2 text-xs">
                      <li><code className="bg-muted px-1 rounded">iotctl status</code> - Device health and metrics</li>
                      <li><code className="bg-muted px-1 rounded">iotctl config show</code> - Show all configuration</li>
                      <li><code className="bg-muted px-1 rounded">iotctl provision status</code> - Provisioning info</li>
                      <li><code className="bg-muted px-1 rounded">iotctl diagnostics</code> - System diagnostics</li>
                    </ul>
                  </div>
                  
                  <div>
                    <p className="font-medium text-foreground mb-1">App Management</p>
                    <ul className="list-disc list-inside space-y-0.5 ml-2 text-xs">
                      <li><code className="bg-muted px-1 rounded">iotctl apps list</code> - List all applications</li>
                      <li><code className="bg-muted px-1 rounded">iotctl apps start &lt;appId&gt;</code> - Start app</li>
                      <li><code className="bg-muted px-1 rounded">iotctl apps stop &lt;appId&gt;</code> - Stop app</li>
                    </ul>
                  </div>
                  
                  <div>
                    <p className="font-medium text-foreground mb-1">Service Management</p>
                    <ul className="list-disc list-inside space-y-0.5 ml-2 text-xs">
                      <li><code className="bg-muted px-1 rounded">iotctl services list</code> - List all services</li>
                      <li><code className="bg-muted px-1 rounded">iotctl services logs &lt;id&gt; -f</code> - Follow logs</li>
                    </ul>
                  </div>
                  
                  <p className="text-xs italic mt-2">
                    Type <code className="bg-muted px-1 rounded">iotctl help</code> for complete command list
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
