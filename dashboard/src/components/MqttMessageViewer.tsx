import { useState, useRef, useEffect } from "react";
import { Copy, Check, FileJson, MessageSquare, Shield } from "lucide-react";
import { buildApiUrl } from "@/config/api";
import { cn } from "./ui/utils";

interface MqttMessageViewerProps {
  selectedTopic: string;
  selectedMessage: string;
}

interface TopicSchema {
  schema: any;
  schemaVersion: number;
  schemaConfidence: number;
  schemaSampleCount: number;
  schemaHash: string;
}

interface TopicAcl {
  id: number;
  username: string;
  clientId: string;
  topic: string;
  access: number;
  accessLabel: string;
  priority: number;
  createdAt: string;
}

export function MqttMessageViewer({ selectedTopic, selectedMessage }: MqttMessageViewerProps) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'message' | 'schema' | 'acls'>('message');
  const [schemaData, setSchemaData] = useState<TopicSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [aclsData, setAclsData] = useState<TopicAcl[]>([]);
  const [aclsLoading, setAclsLoading] = useState(false);
  const [aclsError, setAclsError] = useState<string | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when message changes
  useEffect(() => {
    if (messageRef.current) {
      messageRef.current.scrollTop = messageRef.current.scrollHeight;
    }
  }, [selectedMessage]);

  // Fetch schema when topic changes or schema tab is activated
  useEffect(() => {
    if (activeTab === 'schema' && selectedTopic && !schemaData) {
      fetchTopicSchema();
    }
  }, [activeTab, selectedTopic]);

  // Fetch ACLs when topic changes or ACLs tab is activated
  useEffect(() => {
    if (activeTab === 'acls' && selectedTopic && aclsData.length === 0) {
      fetchTopicAcls();
    }
  }, [activeTab, selectedTopic]);

  // Reset schema and ACLs data when topic changes
  useEffect(() => {
    setSchemaData(null);
    setSchemaError(null);
    setAclsData([]);
    setAclsError(null);
  }, [selectedTopic]);

  const fetchTopicSchema = async () => {
    setSchemaLoading(true);
    setSchemaError(null);
    
    try {
      const accessToken = localStorage.getItem('accessToken');
      const response = await fetch(
        buildApiUrl(`/api/v1/mqtt/topics/${encodeURIComponent(selectedTopic)}/schema`),
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          setSchemaError('No schema available yet. Schema is generated after analyzing message patterns.');
        } else {
          throw new Error(`Failed to fetch schema: ${response.statusText}`);
        }
        return;
      }

      const result = await response.json();
      if (result.success && result.data) {
        setSchemaData(result.data);
      }
    } catch (error: any) {
      console.error('Error fetching topic schema:', error);
      setSchemaError(error.message || 'Failed to load schema');
    } finally {
      setSchemaLoading(false);
    }
  };

  const fetchTopicAcls = async () => {
    setAclsLoading(true);
    setAclsError(null);
    
    try {
      const accessToken = localStorage.getItem('accessToken');
      const response = await fetch(
        buildApiUrl(`/api/v1/mqtt/topics/${encodeURIComponent(selectedTopic)}/acls`),
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch ACLs: ${response.statusText}`);
      }

      const result = await response.json();
      if (result.success && result.data) {
        setAclsData(result.data.acls || []);
      }
    } catch (error: any) {
      console.error('Error fetching topic ACLs:', error);
      setAclsError(error.message || 'Failed to load ACLs');
    } finally {
      setAclsLoading(false);
    }
  };

  // Copy topic to clipboard
  const handleCopyTopic = async () => {
    try {
      await navigator.clipboard.writeText(selectedTopic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
    } catch (err) {
      console.error('Failed to copy topic:', err);
    }
  };

  // Try to parse and format JSON
  const formatJsonMessage = (message: string) => {
    try {
      const parsed = JSON.parse(message);
      const formatted = JSON.stringify(parsed, null, 2);
      
      // Add syntax highlighting with theme-aware colors
      return formatted
        .replace(/(".*?"):/g, '<span class="text-blue-600 dark:text-blue-400 font-medium">$1</span>:')  // Keys
        .replace(/: (".*?")/g, ': <span class="text-green-600 dark:text-green-400">$1</span>')  // String values
        .replace(/: (true|false)/g, ': <span class="text-purple-600 dark:text-purple-400 font-semibold">$1</span>')  // Booleans
        .replace(/: (null)/g, ': <span class="text-muted-foreground italic">$1</span>')  // Null
        .replace(/: (-?\d+\.?\d*)/g, ': <span class="text-orange-600 dark:text-orange-400">$1</span>');  // Numbers
    } catch (e) {
      return message; // Return as-is if not valid JSON
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 bg-muted">
      <div className="mb-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <p className="text-xs font-semibold text-muted-foreground">Topic:</p>
          <button
            onClick={handleCopyTopic}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 rounded transition-colors"
            title={copied ? "Copied!" : "Copy topic"}
          >
            {copied ? (
              <>
        <button
          onClick={() => setActiveTab('acls')}
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-b-2",
            activeTab === 'acls'
              ? "border-blue-600 text-blue-600 dark:text-blue-400"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Shield className="w-4 h-4" />
          ACLs
        </button>
                <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
                <span className="text-green-600 dark:text-green-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <p className="text-xs font-mono text-foreground break-all">{selectedTopic}</p>
      </div>
      
      {/* Tabs */}
      <div className="mb-3 flex gap-2 border-b border-border">
        <button
          onClick={() => setActiveTab('message')}
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-b-2",
            activeTab === 'message'
              ? "border-blue-600 text-blue-600 dark:text-blue-400"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <MessageSquare className="w-4 h-4" />
          Last Message
        </button>
        <button
          onClick={() => setActiveTab('schema')}
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-b-2",
            activeTab === 'schema'
              ? "border-blue-600 text-blue-600 dark:text-blue-400"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <FileJson className="w-4 h-4" />
          Schema
        </button>
        <button
          onClick={() => setActiveTab('acls')}
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-b-2",
            activeTab === 'acls'
              ? "border-blue-600 text-blue-600 dark:text-blue-400"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Shield className="w-4 h-4" />
          ACLs
        </button>
      </div>
      
      {/* Tab Content */}
      {activeTab === 'message' ? (
        <div
          ref={messageRef}
          className="bg-card rounded p-3 font-mono text-xs overflow-auto border border-border"
          style={{ 
            height: '500px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'hsl(var(--muted-foreground)) hsl(var(--muted))'
          }}
        >
          <pre 
            className="text-foreground whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{ __html: formatJsonMessage(selectedMessage) }}
          />
        </div>
      ) : activeTab === 'schema' ? (
        <div
          className="bg-card rounded p-3 font-mono text-xs overflow-auto border border-border"
          style={{ 
            height: '500px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'hsl(var(--muted-foreground)) hsl(var(--muted))'
          }}
        >
          {schemaLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-2"></div>
                <p>Loading schema...</p>
              </div>
            </div>
          ) : schemaError ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <FileJson className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>{schemaError}</p>
              </div>
            </div>
          ) : schemaData ? (
            <div className="text-foreground">
              {/* Schema Metadata */}
              <div className="mb-4 pb-3 border-b border-border">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Version:</span>{' '}
                    <span className="font-semibold">{schemaData.schemaVersion}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Confidence:</span>{' '}
                    <span className="font-semibold">
                      {(schemaData.schemaConfidence * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Sample Count:</span>{' '}
                    <span className="font-semibold">{schemaData.schemaSampleCount}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Hash:</span>{' '}
                    <span className="font-mono text-[10px]">
                      {schemaData.schemaHash.substring(0, 8)}...
                    </span>
                  </div>
                </div>
              </div>
              
              {/* Schema JSON */}
              <pre 
                className="whitespace-pre-wrap break-words"
                dangerouslySetInnerHTML={{ 
                  __html: formatJsonMessage(JSON.stringify(schemaData.schema, null, 2)) 
                }}
              />
            </div>
          ) : null}
        </div>
      ) : activeTab === 'acls' ? (
        <div
          className="bg-card rounded p-3 overflow-auto border border-border"
          style={{ 
            height: '500px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'hsl(var(--muted-foreground)) hsl(var(--muted))'
          }}
        >
          {aclsLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-2"></div>
                <p>Loading ACLs...</p>
              </div>
            </div>
          ) : aclsError ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <Shield className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>{aclsError}</p>
              </div>
            </div>
          ) : aclsData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <Shield className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No ACL rules found for this topic</p>
              </div>
            </div>
          ) : (
            <div className="text-foreground">
              <div className="mb-3">
                <p className="text-sm text-muted-foreground">
                  {aclsData.length} ACL rule{aclsData.length !== 1 ? 's' : ''} found
                </p>
              </div>
              
              {/* ACL Rules Table */}
              <div className="space-y-3">
                {aclsData.map((acl) => (
                  <div
                    key={acl.id}
                    className="p-3 bg-muted rounded-lg border border-border"
                  >
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Username:</span>{' '}
                        <span className="font-mono font-semibold">{acl.username}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Client ID:</span>{' '}
                        <span className="font-mono font-semibold">{acl.clientId}</span>
                      </div>
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Topic Pattern:</span>{' '}
                        <span className="font-mono text-blue-600 dark:text-blue-400">{acl.topic}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Access:</span>{' '}
                        <span className={cn(
                          "font-semibold",
                          acl.access === 3 ? "text-green-600 dark:text-green-400" :
                          acl.access === 2 ? "text-orange-600 dark:text-orange-400" :
                          "text-blue-600 dark:text-blue-400"
                        )}>
                          {acl.accessLabel}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Priority:</span>{' '}
                        <span className="font-semibold">{acl.priority}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
