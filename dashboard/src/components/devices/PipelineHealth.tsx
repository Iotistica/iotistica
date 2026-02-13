/**
 * Pipeline Health Component
 * Shows data pipeline infrastructure status (collapsible)
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Pipeline {
  name: string;
  state: string;
  healthy: boolean;
  messagesReceived: string | number;
  messagesPublished: string | number;
  lastActivity: string | null;
  lastError: string | null;
  lastSeen: string;
}

interface PipelineHealthProps {
  pipelines: Pipeline[];
}

const formatTimeAgo = (timestamp: string): string => {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h ago`;
};

export const PipelineHealth: React.FC<PipelineHealthProps> = ({ pipelines }) => {
  const [expanded, setExpanded] = useState(false);

  if (pipelines.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader 
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-5 w-5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            )}
            <CardTitle className="text-lg">Data Pipeline Health (Infrastructure)</CardTitle>
          </div>
          <Badge variant="secondary">{pipelines.length} pipeline(s)</Badge>
        </div>
      </CardHeader>
      
      {expanded && (
        <CardContent className="space-y-4">
          {pipelines.map((pipeline) => (
            <div 
              key={pipeline.name}
              className="border rounded-lg p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Activity className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <h4 className="font-medium">{pipeline.name}</h4>
                    <p className="text-sm text-muted-foreground">
                      State: {pipeline.state}
                    </p>
                  </div>
                </div>
                <Badge variant={pipeline.healthy ? 'default' : 'destructive'}>
                  {pipeline.healthy ? '✓ Healthy' : '✗ Unhealthy'}
                </Badge>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Messages Received</p>
                  <p className="font-medium">{pipeline.messagesReceived}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Messages Published</p>
                  <p className="font-medium">{pipeline.messagesPublished}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Last Activity</p>
                  <p className="font-medium">
                    {pipeline.lastActivity ? formatTimeAgo(pipeline.lastActivity) : 'Never'}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Last Seen</p>
                  <p className="font-medium">{formatTimeAgo(pipeline.lastSeen)}</p>
                </div>
              </div>

              {pipeline.lastError && (
                <div className="bg-muted rounded p-3">
                  <p className="text-sm">
                    <span className="font-medium">Last Error:</span>{' '}
                    <span className="text-muted-foreground">{pipeline.lastError}</span>
                  </p>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
};
