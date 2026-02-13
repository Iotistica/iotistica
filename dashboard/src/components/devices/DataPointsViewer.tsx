/**
 * DataPointsViewer - Protocol-aware data points display component
 * Renders data points differently based on protocol (Modbus, OPC-UA, etc.)
 */

import React from 'react';
import { Badge } from '@/components/ui/badge';

interface ModbusDataPoint {
  name: string;
  address: number;
  type: string;
  dataType: string;
  unit?: string;
  scale?: number;
  description?: string;
  base?: number;
  noise_pct?: number;
}

interface OPCUADataPoint {
  name: string;
  nodeId: string;
}

interface DataPointsViewerProps {
  protocol: string;
  dataPoints: ModbusDataPoint[] | OPCUADataPoint[];
}

export const DataPointsViewer: React.FC<DataPointsViewerProps> = ({ protocol, dataPoints }) => {
  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        No data points configured
      </div>
    );
  }

  if (protocol === 'modbus') {
    return <ModbusDataPointsTable dataPoints={dataPoints as ModbusDataPoint[]} />;
  }

  if (protocol === 'opcua') {
    return <OPCUADataPointsTable dataPoints={dataPoints as OPCUADataPoint[]} />;
  }

  // Generic fallback
  return (
    <div className="text-sm text-muted-foreground py-4">
      <pre className="bg-muted p-3 rounded-md overflow-x-auto">
        {JSON.stringify(dataPoints, null, 2)}
      </pre>
    </div>
  );
};

// Modbus-specific table
const ModbusDataPointsTable: React.FC<{ dataPoints: ModbusDataPoint[] }> = ({ dataPoints }) => {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-foreground">Name</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Address</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Type</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Data Type</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Scale</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Unit</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Description</th>
          </tr>
        </thead>
        <tbody>
          {dataPoints.map((point, idx) => (
            <tr key={idx} className="border-b border-border hover:bg-muted/50 transition-colors">
              <td className="py-2 px-3 font-medium text-foreground">{point.name}</td>
              <td className="py-2 px-3 text-muted-foreground">
                <Badge variant="outline" className="font-mono text-xs">
                  {point.address}
                </Badge>
              </td>
              <td className="py-2 px-3">
                <Badge variant="secondary" className="text-xs">
                  {point.type}
                </Badge>
              </td>
              <td className="py-2 px-3 text-muted-foreground font-mono text-xs">{point.dataType}</td>
              <td className="py-2 px-3 text-muted-foreground">
                {point.scale ? `×${point.scale}` : '—'}
              </td>
              <td className="py-2 px-3 text-muted-foreground">{point.unit || '—'}</td>
              <td className="py-2 px-3 text-muted-foreground text-xs">{point.description || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// OPC-UA-specific table
const OPCUADataPointsTable: React.FC<{ dataPoints: OPCUADataPoint[] }> = ({ dataPoints }) => {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-3 font-medium text-foreground">Name</th>
            <th className="text-left py-2 px-3 font-medium text-foreground">Node ID</th>
          </tr>
        </thead>
        <tbody>
          {dataPoints.map((point, idx) => (
            <tr key={idx} className="border-b border-border hover:bg-muted/50 transition-colors">
              <td className="py-2 px-3 font-medium text-foreground">{point.name}</td>
              <td className="py-2 px-3 font-mono text-xs text-muted-foreground">
                <Badge variant="outline" className="font-mono">
                  {point.nodeId}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
