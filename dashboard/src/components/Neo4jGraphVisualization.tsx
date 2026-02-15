/**
 * Neo4j Graph Visualization Component
 * 
 * Renders building hierarchy graph from Neo4j using Cytoscape.js
 * with dark Neo4j-style theme and interactive controls.
 */

import React, { useEffect, useRef, useState } from 'react';
import cytoscape, { Core, NodeSingular } from 'cytoscape';
import axios from 'axios';
import { getApiUrl } from '../config/api';
import { Building2, Layers, Box, Cpu, Radio, ChevronRight, ChevronLeft, Trash2, Link2, X, Info } from 'lucide-react';
import { DeviceMappingPanel } from './DeviceMappingPanel';

const API_BASE_URL = getApiUrl();

interface GraphNode {
  id: string;
  labels: string[];
  properties: {
    name?: string;
    expressId?: number;
    uuid?: string;
    [key: string]: any;
  };
}

interface GraphRelationship {
  type: string;
  from: string;
  to: string;
}

interface GraphData {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

interface Space {
  expressId: number;
  name: string;
}

interface Neo4jGraphVisualizationProps {
  selectedDeviceUuid?: string;
  selectedDeviceName?: string;
  onMappingComplete?: () => void;
}

// Neo4j color palette
const NODE_COLORS = {
  Project: { main: '#57C7E3', border: '#79D4EC', glow: 'rgba(87, 199, 227, 0.5)' },
  Site: { main: '#57C7E3', border: '#79D4EC', glow: 'rgba(87, 199, 227, 0.5)' },
  Building: { main: '#4C8EDA', border: '#6BA3E8', glow: 'rgba(76, 142, 218, 0.5)' },
  Floor: { main: '#DA7194', border: '#E48FAB', glow: 'rgba(218, 113, 148, 0.5)' },
  Space: { main: '#F79767', border: '#F9AC85', glow: 'rgba(247, 151, 103, 0.5)' },
  EdgeDevice: { main: '#F79767', border: '#F9AC85', glow: 'rgba(247, 151, 103, 0.5)' },
  Sensor: { main: '#57C7E3', border: '#79D4EC', glow: 'rgba(87, 199, 227, 0.5)' },
  default: { main: '#8DCC93', border: '#A3D9A8', glow: 'rgba(141, 204, 147, 0.5)' },
};

export const Neo4jGraphVisualization: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [showMappingPanel, setShowMappingPanel] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [modalNode, setModalNode] = useState<GraphNode | null>(null);

  // Debug: Track showMappingPanel state changes
  useEffect(() => {
    console.log('Device Mapping Panel state:', showMappingPanel);
  }, [showMappingPanel]);

  useEffect(() => {
    loadGraph();
    return () => {
      cyRef.current?.destroy();
    };
  }, []);

  const loadGraph = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await axios.get<{ success: boolean; data: GraphData }>(
        `${API_BASE_URL}/api/v1/digital-twin/graph`
      );

      if (!response.data.success) {
        throw new Error('Failed to load graph data');
      }

      const graphData = response.data.data;
      
      // Extract spaces for device mapping
      const spaceNodes = graphData.nodes
        .filter(node => node.labels.includes('Space'))
        .map(node => ({
          expressId: node.properties.expressId!,
          name: node.properties.name || `Space ${node.id}`,
        }));
      setSpaces(spaceNodes);
      
      // Debug logging
      console.log('📊 Graph Data Received:');
      console.log(`- Total Nodes: ${graphData.nodes.length}`);
      graphData.nodes.forEach(node => {
        console.log(`  - ${node.labels[0]}: ${node.properties.name || node.id}`);
      });
      console.log(`- Total Relationships: ${graphData.relationships.length}`);
      graphData.relationships.forEach(rel => {
        console.log(`  - ${rel.type}: from=${rel.from} to=${rel.to}`);
        console.log(`    Full rel object:`, JSON.stringify(rel));
      });
      
      renderGraph(graphData);
      setStats({
        nodes: graphData.nodes.length,
        edges: graphData.relationships.length,
      });
    } catch (err: any) {
      console.error('Failed to load graph:', err);
      setError(err.message || 'Failed to load graph data');
    } finally {
      setLoading(false);
    }
  };

  const renderGraph = (data: GraphData) => {
    if (!containerRef.current) return;

    // Transform data to Cytoscape format
    const elements = [
      // Nodes
      ...data.nodes.map((node) => {
        const label = node.labels[0] || 'default';
        const colors = NODE_COLORS[label as keyof typeof NODE_COLORS] || NODE_COLORS.default;
        
        return {
          data: {
            id: node.id,
            label: node.properties.name || `${label} ${node.id}`,
            nodeType: label,
            properties: node.properties,
          },
          style: {
            'background-color': colors.main,
            'border-color': colors.border,
            'border-width': 3,
            'color': '#e2e8f0',
            'text-outline-color': '#1a1a1a',
            'text-outline-width': 2,
            'font-size': 12,
            'font-weight': 'bold',
            'width': 80,
            'height': 80,
            'shape': 'ellipse',
            'box-shadow-blur': 20,
            'box-shadow-color': colors.glow,
            'box-shadow-opacity': 0.8,
          },
        };
      }),
      // Edges
      ...data.relationships.map((rel, idx) => ({
        data: {
          id: `edge-${idx}`,
          source: rel.from,
          target: rel.to,
          label: rel.type,
        },
        style: {
          'line-color': '#4a5568',
          'target-arrow-color': '#4a5568',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'width': 2,
          'arrow-scale': 1.5,
          'font-size': 10,
          'color': '#94a3b8',
          'text-outline-color': '#1a1a1a',
          'text-outline-width': 1,
        },
      })),
    ];

    // Initialize Cytoscape
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'edge',
          style: {
            label: 'data(label)',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 5,
            'border-color': '#fff',
            'box-shadow-blur': 30,
            'box-shadow-opacity': 1,
          },
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color': '#60a5fa',
            'target-arrow-color': '#60a5fa',
            'width': 3,
          },
        },
        {
          selector: 'node.node-hover',
          style: {
            'border-width': 4,
            'border-color': '#60a5fa',
            'box-shadow-blur': 25,
            'box-shadow-opacity': 1,
          },
        },
      ],
      layout: {
        name: 'breadthfirst',
        directed: true,
        spacingFactor: 1.5,
        animate: true,
        animationDuration: 500,
      },
      minZoom: 0.3,
      maxZoom: 3,
      wheelSensitivity: 0.2,
    });

    // Event handlers
    cy.on('tap', 'node', (event) => {
      const node = event.target;
      const nodeData: GraphNode = {
        id: node.id(),
        labels: [node.data('nodeType')],
        properties: node.data('properties'),
      };
      setSelectedNode(nodeData);
      setContextMenu(null); // Close context menu on node click
    });

    cy.on('tap', (event) => {
      if (event.target === cy) {
        setSelectedNode(null);
        setContextMenu(null);
      }
    });

    // Right-click context menu
    cy.on('cxttap', 'node', (event) => {
      // Prevent default browser context menu
      event.originalEvent?.preventDefault();
      event.originalEvent.stopPropagation();
      
      const node = event.target;
      const nodeData: GraphNode = {
        id: node.id(),
        labels: [node.data('nodeType')],
        properties: node.data('properties'),
      };
      
      // Only show context menu for EdgeDevice nodes
      if (nodeData.labels.includes('EdgeDevice')) {
        const renderedPosition = node.renderedPosition();
        const container = containerRef.current?.getBoundingClientRect();
        
        if (container) {
          setContextMenu({
            x: renderedPosition.x + container.left,
            y: renderedPosition.y + container.top,
            node: nodeData,
          });
        }
      }
    });

    // Hover tooltip events
    cy.on('mouseover', 'node', (event) => {
      const node = event.target;
      const nodeType = node.data('nodeType');
      const props = node.data('properties');
      
      // Create tooltip content
      let tooltipContent = `<div style="font-weight: bold; margin-bottom: 4px;">${nodeType}</div>`;
      tooltipContent += `<div style="color: #94a3b8;">${props.name || node.id()}</div>`;
      
      if (props.expressId) {
        tooltipContent += `<div style="color: #94a3b8; font-size: 11px; margin-top: 4px;">ID: ${props.expressId}</div>`;
      }
      
      if (props.uuid) {
        tooltipContent += `<div style="color: #94a3b8; font-size: 11px;">UUID: ${props.uuid.substring(0, 8)}...</div>`;
      }

      node.data('tooltip', tooltipContent);
      node.addClass('node-hover');
    });

    cy.on('mouseout', 'node', (event) => {
      const node = event.target;
      node.removeClass('node-hover');
    });
    cyRef.current = cy;

    // Disable native context menu inside the actual canvas layer
    containerRef.current
      ?.querySelectorAll('canvas, div')
      .forEach(el => {
        el.addEventListener('contextmenu', (e) => e.preventDefault());
      });
  };

  const fitGraph = () => {
    cyRef.current?.fit(undefined, 50);
  };

  const resetView = () => {
    cyRef.current?.reset();
  };

  const handleDeleteNode = async (node: GraphNode) => {
    if (!node.properties.uuid) {
      alert('Cannot delete: Node has no UUID');
      return;
    }

    if (!window.confirm(`Delete unmapped device "${node.properties.name || node.properties.uuid}"?\n\nThis action cannot be undone.`)) {
      return;
    }

    try {
      const response = await axios.delete(
        `${API_BASE_URL}/api/v1/digital-twin/graph/node/${node.id}?uuid=${node.properties.uuid}`
      );

      if (response.data.success) {
        setContextMenu(null);
        setSelectedNode(null);
        await loadGraph(); // Reload graph
        alert('Device deleted successfully');
      } else {
        alert(response.data.message || 'Failed to delete device');
      }
    } catch (error: any) {
      console.error('Failed to delete node:', error);
      const message = error.response?.data?.message || error.message || 'Failed to delete device';
      alert(message);
    }
  };

  const handleUnmapNode = async (node: GraphNode) => {
    if (!node.properties.uuid) {
      alert('Cannot unmap: Node has no UUID');
      return;
    }

    if (!window.confirm(`Unmap device "${node.properties.name || node.properties.uuid}" from its space?`)) {
      return;
    }

    try {
      const response = await axios.delete(
        `${API_BASE_URL}/api/v1/digital-twin/graph/map-device/${node.properties.uuid}`
      );

      if (response.data.success) {
        setContextMenu(null);
        await loadGraph(); // Reload graph
        alert('Device unmapped successfully');
      }
    } catch (error: any) {
      console.error('Failed to unmap device:', error);
      alert(error.response?.data?.message || error.message || 'Failed to unmap device');
    }
  };

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [contextMenu]);

  const getNodeIcon = (nodeType: string) => {
    switch (nodeType) {
      case 'Building':
        return <Building2 className="w-5 h-5" />;
      case 'Floor':
        return <Layers className="w-5 h-5" />;
      case 'Space':
        return <Box className="w-5 h-5" />;
      case 'EdgeDevice':
        return <Cpu className="w-5 h-5" />;
      case 'Sensor':
        return <Radio className="w-5 h-5" />;
      default:
        return <Box className="w-5 h-5" />;
    }
  };

  return (
    <div className="h-full w-full flex flex-col" style={{ background: '#1a1a1a' }}>
      {/* Header */}
      <div className="px-6 py-4 border-b" style={{ borderColor: '#2d3748', background: '#1f1f1f' }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold" style={{ color: '#e2e8f0' }}>
              Digital Twin Graph
            </h2>
            <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
              {stats.nodes} nodes, {stats.edges} relationships
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={fitGraph}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: '#2d3748',
                color: '#e2e8f0',
                border: '1px solid #4a5568',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#374151')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#2d3748')}
            >
              Fit View
            </button>
            <button
              onClick={resetView}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: '#2d3748',
                color: '#e2e8f0',
                border: '1px solid #4a5568',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#374151')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#2d3748')}
            >
              Reset
            </button>
            <button
              onClick={loadGraph}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: '#2d3748',
                color: '#e2e8f0',
                border: '1px solid #4a5568',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#374151')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#2d3748')}
            >
              Refresh
            </button>
            <button
              onClick={() => setShowMappingPanel(!showMappingPanel)}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
              style={{
                background: showMappingPanel ? '#4C8EDA' : '#2d3748',
                color: '#e2e8f0',
                border: `1px solid ${showMappingPanel ? '#4C8EDA' : '#4a5568'}`,
              }}
              onMouseEnter={(e) => !showMappingPanel && (e.currentTarget.style.background = '#374151')}
              onMouseLeave={(e) => !showMappingPanel && (e.currentTarget.style.background = '#2d3748')}
            >
              {showMappingPanel ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
              Device Mapping
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex">
        {/* Graph Container */}
        <div className="flex-1 relative">
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: '#1a1a1a' }}
            >
              <div className="text-center">
                <div className="w-16 h-16 border-4 border-t-transparent rounded-full animate-spin mx-auto mb-4"
                  style={{ borderColor: '#4C8EDA', borderTopColor: 'transparent' }}
                />
                <p style={{ color: '#94a3b8' }}>Loading graph...</p>
              </div>
            </div>
          )}

          {error && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: '#1a1a1a' }}
            >
              <div className="text-center max-w-md">
                <div className="text-red-400 text-4xl mb-4">⚠️</div>
                <p className="text-lg font-semibold mb-2" style={{ color: '#e2e8f0' }}>
                  Failed to load graph
                </p>
                <p className="text-sm mb-4" style={{ color: '#94a3b8' }}>
                  {error}
                </p>
                <button
                  onClick={loadGraph}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{
                    background: '#4C8EDA',
                    color: '#fff',
                  }}
                >
                  Try Again
                </button>
              </div>
            </div>
          )}

          <div 
            ref={containerRef} 
            className="w-full h-full"
            onContextMenu={(e) => e.preventDefault()}
          />

          {/* Context Menu */}
          {contextMenu && (
            <div
              className="fixed z-50 shadow-lg rounded-lg overflow-hidden"
              style={{
                left: contextMenu.x,
                top: contextMenu.y,
                background: '#1f1f1f',
                border: '1px solid #4a5568',
                minWidth: '200px',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="py-2">
                {/* Node Info */}
                <div className="px-4 py-2 border-b" style={{ borderColor: '#2d3748' }}>
                  <div className="text-xs font-medium" style={{ color: '#94a3b8' }}>
                    {contextMenu.node.labels[0]}
                  </div>
                  <div className="text-sm font-semibold mt-1" style={{ color: '#e2e8f0' }}>
                    {contextMenu.node.properties.name || contextMenu.node.id}
                  </div>
                </div>

                {/* Actions */}
                <div className="py-1">
                  <button
                    onClick={() => handleUnmapNode(contextMenu.node)}
                    className="w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2"
                    style={{ color: '#e2e8f0' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#2d3748')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>🔗</span>
                    <span>Unmap from Space</span>
                  </button>
                  
                  <button
                    onClick={() => handleDeleteNode(contextMenu.node)}
                    className="w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2"
                    style={{ color: '#ef4444' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#2d3748')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>🗑️</span>
                    <span>Delete Device</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Side Panel */}
        {selectedNode && (
          <div
            className="w-80 border-l overflow-y-auto"
            style={{ borderColor: '#2d3748', background: '#1f1f1f' }}
          >
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="p-3 rounded-lg"
                  style={{
                    background: '#2d3748',
                    color: NODE_COLORS[selectedNode.labels[0] as keyof typeof NODE_COLORS]?.main || '#8DCC93',
                  }}
                >
                  {getNodeIcon(selectedNode.labels[0])}
                </div>
                <div className="flex-1">
                  <div className="text-xs font-medium mb-1" style={{ color: '#94a3b8' }}>
                    {selectedNode.labels[0]}
                  </div>
                  <div className="text-lg font-semibold" style={{ color: '#e2e8f0' }}>
                    {selectedNode.properties.name || selectedNode.id}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <div className="text-xs font-medium mb-2" style={{ color: '#94a3b8' }}>
                    PROPERTIES
                  </div>
                  <div className="space-y-2">
                    {Object.entries(selectedNode.properties).map(([key, value]) => (
                      <div
                        key={key}
                        className="p-3 rounded-lg"
                        style={{ background: '#2d3748' }}
                      >
                        <div className="text-xs mb-1" style={{ color: '#94a3b8' }}>
                          {key}
                        </div>
                        <div className="text-sm font-medium" style={{ color: '#e2e8f0' }}>
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Device Mapping Panel */}
        {showMappingPanel && (
          <div
            key="device-mapping-panel"
            className="w-96 border-l"
            style={{ borderColor: '#2d3748', background: '#1f1f1f' }}
          >
            <DeviceMappingPanel 
              spaces={spaces} 
              onMappingChange={loadGraph}
            />
          </div>
        )}
      </div>

      {/* Legend */}
      <div
        className="px-6 py-4 border-t flex items-center gap-6"
        style={{ borderColor: '#2d3748', background: '#1f1f1f' }}
      >
        <div className="text-xs font-medium" style={{ color: '#94a3b8' }}>
          LEGEND
        </div>
        {Object.entries(NODE_COLORS).map(([type, colors]) => (
          <div key={type} className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{
                background: colors.main,
                border: `2px solid ${colors.border}`,
                boxShadow: `0 0 8px ${colors.glow}`,
              }}
            />
            <span className="text-xs" style={{ color: '#cbd5e0' }}>
              {type}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
