import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Terminal as TerminalIcon, Power, Plus, List} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  const autoConnectPendingRef = useRef<boolean>(false);
  const currentSessionIdRef = useRef<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [ptyRestarted, setPtyRestarted] = useState(false);

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    
    setIsConnecting(true);
    
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname;
    const wsPort = import.meta.env.VITE_API_PORT || '4002';
    const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/ws?deviceUuid=${deviceUuid}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsConnecting(false);
      
      // Subscribe to shell channel
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'shell',
      }));

      if (xtermRef.current) {
        xtermRef.current.writeln('\x1b[32m✓ Connected to WebSocket\x1b[0m');
      }

      // Auto-connect: List existing sessions
      ws.send(JSON.stringify({
        type: 'list-sessions',
        deviceUuid,
      }));
      autoConnectPendingRef.current = true;
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
      if (xtermRef.current) {
        xtermRef.current.writeln('\r\n\x1b[31m✗ Disconnected from device\x1b[0m');
      }
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
              userId: user?.id,
            },
          }));
        }
        break;

      case 'session-attached':
        setCurrentSessionId(message.sessionId);
        currentSessionIdRef.current = message.sessionId;
        
        // Check for PTY restart (nested under data)
        const ptyRestarted = message.data?.ptyRestarted || message.ptyRestarted;
        if (ptyRestarted) {
          setPtyRestarted(true);
          if (xtermRef.current) {
            xtermRef.current.writeln('\x1b[33m⚠ Session PTY was restarted - waiting for connection...\x1b[0m');
          }
        }

        if (xtermRef.current) {
          xtermRef.current.clear();
          xtermRef.current.writeln('\x1b[32m✓ Attached to session\x1b[0m');
          
          // Display buffered output (check both data.buffer and buffer for compatibility)
          const buffer = message.data?.buffer || message.buffer;
          if (buffer && buffer.length > 0) {
            buffer.forEach((chunk: string) => {
              xtermRef.current?.write(chunk);
            });
          } else {
            xtermRef.current.writeln('\x1b[90m(No buffered output)\x1b[0m');
          }
          
          xtermRef.current.writeln('');
        }

        // Send terminal size to backend for proper PTY configuration
        resizeSession();

        // Refresh session list
        listSessions();
        break;

      case 'session-detached':
        setCurrentSessionId(null);
        currentSessionIdRef.current = null;
        if (xtermRef.current) {
          xtermRef.current.writeln('\r\n\x1b[33m⚠ Session detached\x1b[0m');
        }
        listSessions();
        break;

      case 'session-terminated':
        if (message.sessionId === currentSessionId) {
          setCurrentSessionId(null);
          currentSessionIdRef.current = null;
        }
        if (xtermRef.current) {
          xtermRef.current.writeln('\r\n\x1b[31m✗ Session terminated\x1b[0m');
        }
        listSessions();
        break;

      case 'sessions-list':
        const sessionsList = message.data?.sessions || message.sessions || [];
        // Filter out terminated sessions - only show active/detached (usable) sessions
        const usableSessions = sessionsList.filter((s: SessionInfo) => 
          s.status === 'active' || s.status === 'detached'
        );
        setSessions(usableSessions);
        
        // Auto-connect logic: attach to most recent active/detached session OR create new
        if (autoConnectPendingRef.current) {
          autoConnectPendingRef.current = false;
          
          const existingSessions = sessionsList.filter((s: SessionInfo) => 
            s.status === 'active' || s.status === 'detached'
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
            if (xtermRef.current) {
              xtermRef.current.writeln(`\x1b[90mCreating new session...\x1b[0m`);
            }
            createNewSession();
          }
        }
        break;

      case 'shell-output':
        if (message.sessionId === currentSessionIdRef.current && message.data?.output) {
          if (xtermRef.current) {
            xtermRef.current.write(message.data.output);
          }
          // Clear PTY restart warning on first output
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
        console.error('[RemoteAccess] Server error:', errorMsg);
        if (xtermRef.current) {
          xtermRef.current.writeln(`\r\n\x1b[31m✗ Error: ${errorMsg}\x1b[0m`);
        }
        break;

      default:
        break;
    }
  };

  const createNewSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[RemoteAccess] WebSocket not connected');
      return;
    }

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

  const attachToSession = (sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[RemoteAccess] WebSocket not connected');
      return;
    }

    if (!sessionId) {
      console.error('[RemoteAccess] Cannot attach - sessionId is null/undefined');
      return;
    }
    
    // Detach from current session first
    if (currentSessionId && currentSessionId !== sessionId) {
      detachFromSession();
    }

    const msg = {
      type: 'attach-session',
      data: { 
        sessionId,
        userId: user?.id,
      },
    };
    wsRef.current.send(JSON.stringify(msg));

    if (xtermRef.current) {
      xtermRef.current.writeln(`\x1b[90mAttaching to session ${sessionId.substring(0, 8)}...\x1b[0m`);
    }
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
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!currentSessionIdRef.current) {
      return;
    }

    const msg = {
      type: 'shell-input',
      data: {
        sessionId: currentSessionIdRef.current,
        input: data,
      },
    };
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
    if (wsRef.current) {
      // Detach from current session (don't terminate - keep it alive)
      if (currentSessionId) {
        detachFromSession();
      }
      
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
      fontSize: 14,
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
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Welcome message
    term.writeln('');
    term.writeln('\x1b[33mClick "Connect" to start a shell session\x1b[0m');
    term.writeln('');

    // Handle user input
    term.onData((data) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!currentSessionIdRef.current) {
        term.write('\x1b[31m✗ Not attached to a session\x1b[0m\r\n');
        return;
      }

      // Send all input directly (don't echo - server will echo back)
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
      window.removeEventListener('resize', handleResize);
      disconnect();
      term.dispose();
    };
  }, []); // No dependencies - stable across session changes

  // Clear sessions and terminal when device changes
  useEffect(() => {
    disconnect();
    setSessions([]);
    setCurrentSessionId(null);
    currentSessionIdRef.current = null;
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.writeln('\x1b[33mDevice changed. Click "Connect" to start new session.\x1b[0m');
    }
  }, [deviceUuid]);

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
                <span className="font-semibold">Shell Terminal</span>
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
                    onClick={connectWebSocket}
                    disabled={isConnecting}
                  >
                    <Power className="h-4 w-4 mr-1" />
                    Connect
                  </Button>
                ) : (
                  <>
                    {/* Sessions Dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          <List className="h-4 w-4 mr-1" />
                          Sessions ({sessions.length})
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuLabel>Active Sessions</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {sessions.length === 0 ? (
                          <DropdownMenuItem disabled>No sessions</DropdownMenuItem>
                        ) : (
                          sessions.map((session) => (
                            <DropdownMenuItem
                              key={session.sessionId}
                              className="flex items-center gap-2 cursor-pointer"
                              onClick={() => attachToSession(session.sessionId)}
                            >
                              <span className="font-mono text-xs">
                                {session.sessionId.substring(0, 8)}
                              </span>
                              {session.sessionId === currentSessionId && (
                                <span className="text-blue-500">●</span>
                              )}
                              <span className="text-xs text-muted-foreground ml-auto">
                                {new Date(session.lastActivity).toLocaleTimeString()}
                              </span>
                            </DropdownMenuItem>
                          ))
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={createNewSession}>
                          <Plus className="h-4 w-4 mr-2" />
                          New Session
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={disconnect}
                    >
                      <Power className="h-4 w-4 mr-1" />
                      Disconnect
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="flex-1 overflow-hidden p-6">
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
