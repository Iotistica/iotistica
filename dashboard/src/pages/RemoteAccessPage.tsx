import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Terminal as TerminalIcon, Power, Plus, Settings, Search } from 'lucide-react';
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
  const inputBufferRef = useRef<string>(''); // Buffer for keystroke batching
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null); // Timer for flushing batched keystrokes
  const reconnectSessionIdRef = useRef<string | null>(null); // Session to reconnect to when socket opens
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [ptyRestarted, setPtyRestarted] = useState(false);
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
    } catch (error) {
      // Silently fail on storage errors
    }
  };
  
  const loadSessionState = (deviceId: string): { sessionId: string; sessions: SessionInfo[] } | null => {
    try {
      const key = `remote-session-${deviceId}`;
      const stored = sessionStorage.getItem(key);
      if (!stored) {
        return null;
      }
      const state = JSON.parse(stored);
      // Expire after 1 hour
      if (Date.now() - state.timestamp > 3600000) {
        sessionStorage.removeItem(key);
        return null;
      }
      return { sessionId: state.sessionId, sessions: state.sessions };
    } catch (error) {
      return null;
    }
  };

  const connectWebSocket = (skipAutoConnect = false) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    
    setIsConnecting(true);

    const token = localStorage.getItem('accessToken');
    const wsUrl = new URL(buildApiUrl('/ws'));
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('deviceUuid', deviceUuid);
    if (token) {
      wsUrl.searchParams.set('token', token);
    }

    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsConnecting(false);
      
      // Subscribe to shell channel
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'shell',
      }));

      // If reconnecting to a saved session, attach immediately (driven by socket lifecycle, not timeout)
      if (reconnectSessionIdRef.current && user?.id) {
        const sessionToReconnect = reconnectSessionIdRef.current;
        reconnectSessionIdRef.current = null; // Clear after using
        
        ws.send(JSON.stringify({
          type: 'attach-session',
          data: { 
            sessionId: sessionToReconnect,
            userId: String(user.id),
          },
        }));
      }
      // Auto-connect: List existing sessions (unless reconnecting to saved session)
      else if (!skipAutoConnect) {
        ws.send(JSON.stringify({
          type: 'list-sessions',
          deviceUuid,
        }));
        autoConnectPendingRef.current = true;
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (error) {
        // Silently ignore parse errors
      }
    };

    ws.onerror = (_error) => {
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
        if (xtermRef.current) {
          xtermRef.current.writeln('\x1b[32m✓ Session created\x1b[0m');
        }
        // Auto-attach to newly created session
        if (wsRef.current && message.sessionId) {
          wsRef.current.send(JSON.stringify({
            type: 'attach-session',
            data: { 
              sessionId: message.sessionId,
              userId: user?.id !== undefined && user?.id !== null ? String(user.id) : undefined,
            },
          }));
        }
        break;

      case 'session-attached': {
        // Clear the attaching flag
        isAttachingRef.current = false;
        
        setCurrentSessionId(message.sessionId);
        currentSessionIdRef.current = message.sessionId;
        currentDeviceUuidRef.current = deviceUuid; // Track which device this session belongs to
        
        // Save session state immediately when attached
        saveSessionState(deviceUuid, message.sessionId, sessions);
        
        // Check for PTY restart (nested under data)
        const ptyWasRestarted = message.data?.ptyRestarted || message.ptyRestarted;
        if (ptyWasRestarted) {
          setPtyRestarted(true);
        }

        if (xtermRef.current) {
          xtermRef.current.clear();
          
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
        listSessions();
        break;

      case 'session-terminated':
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
        // Session status updates - not displayed in UI anymore
        break;

      case 'all-sessions-cleared':
        autoConnectPendingRef.current = false;
        setCurrentSessionId(null);
        currentSessionIdRef.current = null;
        setSessions([]);
        if (xtermRef.current) {
          xtermRef.current.clear();
        }
        setTimeout(() => {
          createNewSession();
        }, 500);
        break;

      case 'sessions-list':
        const sessionsList = message.data?.sessions || message.sessions || [];
        const currentUserId = user?.id !== undefined && user?.id !== null
          ? String(user.id)
          : null;
        const usableSessions = sessionsList.filter((s: SessionInfo) => {
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
        setSessions(usableSessions);
        
        if (autoConnectPendingRef.current && !currentSessionIdRef.current) {
          autoConnectPendingRef.current = false;
          
          if (!user?.id) {
            autoConnectPendingRef.current = true;
            return;
          }
          
          const existingSessions = usableSessions.filter((s: SessionInfo) => s.status === 'active');
          
          if (existingSessions.length > 0) {
            const mostRecent = existingSessions.sort((a: SessionInfo, b: SessionInfo) => 
              new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
            )[0];
            
            if (wsRef.current) {
              wsRef.current.send(JSON.stringify({
                type: 'attach-session',
                data: { 
                  sessionId: mostRecent.sessionId,
                  userId: String(user.id),
                },
              }));
            }
          } else {
            createNewSession();
          }
        }
        break;

      case 'shell-output':
        if (message.data?.output && (message.sessionId === currentSessionIdRef.current || !message.sessionId)) {
          if (xtermRef.current) {
            xtermRef.current.write(message.data.output);
          }
          if (ptyRestarted) {
            setPtyRestarted(false);
          }
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
        
        // If error is about session not found or access denied, clear stale sessionStorage and create new session
        if (
          (errorMsg.includes('Session') && errorMsg.includes('not found')) ||
          errorMsg.includes('Access denied') ||
          errorMsg.includes('has been terminated')
        ) {
          try {
            sessionStorage.removeItem(`remote-session-${deviceUuid}`);
            setCurrentSessionId(null);
            currentSessionIdRef.current = null;
          } catch (e) {
            // Silently fail
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
    if (isAttachingRef.current) {
      return;
    }
    
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    isNewSessionRef.current = true;
    const msg = {
      type: 'create-session',
      deviceUuid,
      data: {
        userId: user?.id !== undefined && user?.id !== null ? String(user.id) : undefined,
      },
    };
    wsRef.current.send(JSON.stringify(msg));
  };


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

  const runCommand = (command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !currentSessionIdRef.current) {
      return;
    }

    // Send command followed by newline to execute it
    const input = command + '\n';
    
    // Add to buffer and flush
    inputBufferRef.current += input;
    
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
    
    // Flush immediately for commands (don't wait 50ms)
    flushTimerRef.current = setTimeout(() => {
      flushInputBuffer();
      flushTimerRef.current = null;
    }, 0);
  };

  const flushInputBuffer = () => {
    if (inputBufferRef.current && wsRef.current?.readyState === WebSocket.OPEN && currentSessionIdRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'shell-input',
        data: {
          sessionId: currentSessionIdRef.current,
          input: inputBufferRef.current,
        },
      }));
      inputBufferRef.current = '';
    }
  };

  const sendInput = (data: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!currentSessionIdRef.current) {
      return;
    }

    // Add to buffer
    inputBufferRef.current += data;
    
    // Clear existing timer and set new one to flush after 50ms
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
    
    flushTimerRef.current = setTimeout(() => {
      flushInputBuffer();
      flushTimerRef.current = null;
    }, 50);
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
    if (wsRef.current) {
      // Terminate session when disconnect button clicked (clean break)
      // Browser navigation/unmount will detach (allowing reconnect)
      const sessionId = currentSessionIdRef.current || currentSessionId;
      if (sessionId) {
        if (xtermRef.current) {
          // Ensure clean line breaks to avoid overlapping active command output
          xtermRef.current.write('\r\n');
          xtermRef.current.writeln('\x1b[90mClosing session...\x1b[0m');
        }
        terminateSession();
        // Clear session from sessionStorage - user wants to disconnect
        sessionStorage.removeItem(`remote-session-${currentDeviceUuidRef.current}`);
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

    // Initialize xterm.js with UX improvements:
    // - copyOnSelect: auto-copy when selecting text
    // - scrollback: 5000 lines of history (instead of default ~1000)
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      theme: {
        background: '#000000',
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
      // Enable copy-on-select for better UX
    } as any);

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
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!currentSessionIdRef.current) {
        term.write('\x1b[31m✗ Not attached to a session\x1b[0m\r\n');
        return;
      }

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
      // Flush any remaining buffered input
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushInputBuffer();
        flushTimerRef.current = null;
      }
      
      // Save session state before cleanup
      if (currentSessionIdRef.current) {
        // Use the device the session belongs to, not the current deviceUuid
        const key = `remote-session-${currentDeviceUuidRef.current}`;
        const state = { 
          sessionId: currentSessionIdRef.current, 
          sessions: [], // Sessions list will be fetched on reconnect
          timestamp: Date.now() 
        };
        sessionStorage.setItem(key, JSON.stringify(state));
        
        // Detach from session (allows reconnect) instead of terminating
        detachFromSession();
      }
      
      window.removeEventListener('resize', handleResize);
      
      // Close WebSocket and dispose terminal
      if (wsRef.current) {
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
      // Safety check: only save if session belongs to current device
      if (currentDeviceUuidRef.current === deviceUuid) {
        saveSessionState(currentDeviceUuidRef.current, currentSessionId, sessions);
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

    wsRef.current.send(JSON.stringify({
      type: 'list-sessions',
      deviceUuid,
    }));
  }, [user?.id, deviceUuid]);

  // Handle device switching - preserve and restore sessions
  useEffect(() => {
    // Save and detach from previous device's session (if exists)
    if (currentSessionIdRef.current && currentDeviceUuidRef.current && currentDeviceUuidRef.current !== deviceUuid) {
      saveSessionState(currentDeviceUuidRef.current, currentSessionIdRef.current, sessions);
      
      detachFromSession();
    }
    
    // Clear session state immediately to prevent save effect from firing with wrong device
    setCurrentSessionId(null);
    
    // Close WebSocket from previous device
    if (wsRef.current) {
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
    currentDeviceUuidRef.current = deviceUuid;
    
    // Check if we have a saved session for this NEW device
    const savedState = loadSessionState(deviceUuid);
    
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
    
    // Restore saved sessions list
    if (savedState) {
      setSessions(savedState.sessions);
    } else {
      setSessions([]);
    }
    
    // Auto-reconnect to previous session (socket lifecycle drives reconnection, not timeout)
    if (savedState?.sessionId) {
      // Store session ID in ref - will be picked up by ws.onopen callback
      reconnectSessionIdRef.current = savedState.sessionId;
      
      // Connect WebSocket (socket's onopen will handle reconnection)
      connectWebSocket(true); // Pass true to skip auto-connect logic
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
                {/* Quick Command Buttons - first in toolbar */}
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => runCommand('iotctl status')}
                  disabled={!currentSessionId}
                >
                  Status
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => runCommand('iotctl diagnostics')}
                  disabled={!currentSessionId}
                >
                  Diagnostics
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => runCommand('iotctl config show')}
                  disabled={!currentSessionId}
                >
                  Config
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => runCommand('iotctl apps list')}
                  disabled={!currentSessionId}
                >
                  Apps
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => runCommand('iotctl services list')}
                  disabled={!currentSessionId}
                >
                  Services
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => runCommand('iotctl provision status')}
                  disabled={!currentSessionId}
                >
                  Provision
                </Button>

                {/* Spacer */}
                <div className="w-4" />

                {/* Connection Status */}
                <Badge 
                  variant={isConnected ? "default" : "secondary"}
                  className={isConnected ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'}
                >
                  {isConnecting ? 'Connecting...' : isConnected ? 'Connected' : 'Disconnected'}
                </Badge>
                
                {/* Spacer */}
                <div className="flex-1" />
                
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

                {/* Spacer to center the toolbar */}
                <div className="flex-1" />

                {/* Search in scrollback - 5000 line history */}
                <Button
                  variant="outline"
                  size="sm"
                  title="Scroll back through history (5000 lines)"
                  onClick={() => {
                    if (xtermRef.current) {
                      xtermRef.current.focus();
                    }
                  }}
                  disabled={!isConnected}
                >
                  <Search className="h-4 w-4" />
                </Button>

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

          <CardContent className="flex-1 overflow-hidden p-6 flex flex-col">
            {/* Terminal area */}
            <div className="flex-1 overflow-hidden">
            
            {/* Terminal Container */}
            <div 
              ref={terminalRef}
              className="rounded-lg w-full h-full"
            />
            </div>
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
