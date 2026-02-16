/**
 * Sensor Table Component
 * Displays all sensors with their status, protocol, and error information
 */

import React from 'react';
import { CheckCircle, XCircle, AlertTriangle, Eye, Clock } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Sensor {
  name: string;
  protocol: string;
  status: 'online' | 'offline' | 'error';
  connected: boolean;
  lastPoll: string | null;
  errorCount: number;
  lastError: string | null;
  lastSeen: string;
}

interface SensorTableProps {
  sensors: Sensor[];
  onViewDetails?: (sensorName: string) => void;
}

const StatusIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'online':
      return <CheckCircle className="h-4 w-4 text-green-600" />;
    case 'offline':
      return <XCircle className="h-4 w-4 text-red-600" />;
    case 'error':
      return <AlertTriangle className="h-4 w-4 text-yellow-600" />;
    default:
      return <Clock className="h-4 w-4 text-gray-400" />;
  }
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const variants: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
    online: 'default',
    offline: 'destructive',
    error: 'secondary',
  };

  const labels: Record<string, string> = {
    online: 'Online',
    offline: 'Offline',
    error: 'Error',
  };

  return (
    <Badge variant={variants[status] || 'secondary'}>
      {labels[status] || 'Unknown'}
    </Badge>
  );
};

const formatTimeAgo = (timestamp: string): string => {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return `${diffSecs}s ago`;
};

export const SensorTable: React.FC<SensorTableProps> = ({ sensors, onViewDetails }) => {
  const handleViewDetails = (sensorName: string) => {
    if (onViewDetails) {
      onViewDetails(sensorName);
    }
  };

  if (sensors.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No sensors configured
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50px]"></TableHead>
            <TableHead>Sensor Name</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Errors</TableHead>
            <TableHead>Last Seen</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sensors.map((sensor) => (
            <React.Fragment key={sensor.name}>
              <TableRow>
                <TableCell>
                  <StatusIcon status={sensor.status} />
                </TableCell>
                <TableCell className="font-medium">{sensor.name}</TableCell>
                <TableCell>
                  <Badge variant="outline">{sensor.protocol.toUpperCase()}</Badge>
                </TableCell>
                <TableCell>
                  <StatusBadge status={sensor.status} />
                </TableCell>
                <TableCell>
                  {sensor.errorCount > 0 ? (
                    <span className="text-destructive font-medium">
                      {sensor.errorCount}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTimeAgo(sensor.lastSeen)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleViewDetails(sensor.name)}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Details
                  </Button>
                </TableCell>
              </TableRow>
              {sensor.lastError && (
                <TableRow className="bg-muted/50">
                  <TableCell></TableCell>
                  <TableCell colSpan={6} className="text-sm text-muted-foreground">
                    <span className="font-medium">Last Error:</span> {sensor.lastError}
                  </TableCell>
                </TableRow>
              )}
            </React.Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
