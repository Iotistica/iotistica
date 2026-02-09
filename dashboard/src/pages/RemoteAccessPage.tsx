import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Terminal as TerminalIcon, Power, RefreshCw } from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface RemoteAccessPageProps {
  deviceUuid: string;
}

export function RemoteAccessPage({ deviceUuid }: RemoteAccessPageProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const connectShell = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    
    setIsConnecting(true);
    
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname;
    const wsPort = import.meta.env.VITE_API_PORT || '4002';
    const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/ws?deviceUuid=${deviceUuid}`;

    console.log('[RemoteAccess] Connecting to WebSocket:', wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[RemoteAccess] WebSocket connected');
      setIsConnected(true);
      setIsConnecting(false);
      
      // Subscribe to shell channel
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'shell',
      }));

      // Send initial message to terminal
      if (xtermRef.current) {
        xtermRef.current.writeln('\x1b[32m✓ Connected to device shell\x1b[0m');
        xtermRef.current.writeln('Type commands below:\r\n');
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'shell' && message.data?.output) {
          console.log('[RemoteAccess] Received shell output');
          if (xtermRef.current) {
            xtermRef.current.write(message.data.output);
          }
        }
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
      console.log('[RemoteAccess] WebSocket disconnected');
      setIsConnected(false);
      setIsConnecting(false);
      if (xtermRef.current) {
        xtermRef.current.writeln('\r\n\x1b[31m✗ Disconnected from device\x1b[0m');
      }
    };
  };

  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'shell',
      }));
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  };

  const reconnect = () => {
    disconnect();
    setTimeout(() => connectShell(), 500);
  };

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
    term.writeln('\x1b[1;36m╔════════════════════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[1;36m║     IoTistic Remote Access Terminal       ║\x1b[0m');
    term.writeln('\x1b[1;36m╚════════════════════════════════════════════╝\x1b[0m');
    term.writeln('');
    term.writeln('\x1b[33mClick "Connect" to start a shell session\x1b[0m');
    term.writeln('');

    // Handle user input
    let commandBuffer = '';
    term.onData((data) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return;
      }

      // Handle special keys
      const code = data.charCodeAt(0);
      
      if (code === 13) { // Enter
        term.write('\r\n');
        if (commandBuffer.trim()) {
          // Send command to device
          wsRef.current.send(JSON.stringify({
            type: 'shell',
            command: commandBuffer + '\n',
          }));
        }
        commandBuffer = '';
      } else if (code === 127) { // Backspace
        if (commandBuffer.length > 0) {
          commandBuffer = commandBuffer.slice(0, -1);
          term.write('\b \b');
        }
      } else if (code === 3) { // Ctrl+C
        wsRef.current.send(JSON.stringify({
          type: 'shell',
          command: '\x03', // Send Ctrl+C signal
        }));
        commandBuffer = '';
        term.write('^C\r\n');
      } else {
        commandBuffer += data;
        term.write(data);
      }
    });

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      disconnect();
      term.dispose();
    };
  }, []);

  // Clear logs when device changes
  useEffect(() => {
    disconnect();
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
            WebSocket-based shell access to device terminal
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
                  {isConnecting ? '🔄 Connecting...' : isConnected ? '🟢 Connected' : '⚫ Disconnected'}
                </Badge>
                
                {/* Connect/Disconnect Button */}
                {!isConnected ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={connectShell}
                    disabled={isConnecting}
                  >
                    <Power className="h-4 w-4 mr-1" />
                    Connect
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={reconnect}
                    >
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Reconnect
                    </Button>
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

        {/* Info Card */}
        <Card className="border">
          <CardContent className="p-4">
            <div className="text-sm text-muted-foreground space-y-2">
              <p><strong>Keyboard Shortcuts:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><kbd>Enter</kbd> - Execute command</li>
                <li><kbd>Ctrl+C</kbd> - Interrupt current process</li>
                <li><kbd>Backspace</kbd> - Delete character</li>
              </ul>
              <p className="mt-4"><strong>Note:</strong> This is a WebSocket-based shell. For advanced SSH features (file transfer, tunneling), use VPN + native SSH client.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
