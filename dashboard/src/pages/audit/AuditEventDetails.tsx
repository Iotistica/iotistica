/**
 * Audit Event Details Panel
 * Right panel showing detailed information about selected event
 */

import React, { useState } from 'react';
import type { AuditEvent } from './types';

interface AuditEventDetailsProps {
  event: AuditEvent | null;
}

export const AuditEventDetails: React.FC<AuditEventDetailsProps> = ({ event }) => {
  const [showRawJson, setShowRawJson] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!event) {
    return (
      <div className="w-96 bg-white border-l border-gray-200 p-6">
        <div className="flex flex-col items-center justify-center h-full text-center">
          <div className="text-6xl mb-4">📋</div>
          <h3 className="text-lg font-semibold text-gray-700 mb-2">
            No Event Selected
          </h3>
          <p className="text-sm text-gray-500">
            Select an event from the stream to view details
          </p>
        </div>
      </div>
    );
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(event, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  };

  const renderValue = (value: any): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  };

  return (
    <div className="w-96 bg-white border-l border-gray-200 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-gray-200 p-4 z-10">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Event Details</h3>
        <div className="flex gap-2">
          <button
            onClick={() => setShowRawJson(!showRawJson)}
            className="text-xs px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded border border-gray-300"
          >
            {showRawJson ? 'Show Formatted' : 'Show Raw JSON'}
          </button>
          <button
            onClick={copyToClipboard}
            className="text-xs px-3 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded border border-blue-300"
          >
            {copied ? '✓ Copied!' : 'Copy JSON'}
          </button>
        </div>
      </div>

      <div className="p-4">
        {showRawJson ? (
          /* Raw JSON View */
          <pre className="bg-gray-900 text-green-400 p-4 rounded-lg text-xs overflow-x-auto">
            {JSON.stringify(event, null, 2)}
          </pre>
        ) : (
          /* Formatted View */
          <div className="space-y-6">
            {/* Basic Info */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3">
                Basic Information
              </h4>
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-gray-600">Event ID</dt>
                  <dd className="text-sm font-mono text-gray-900 break-all">
                    {event.event_id}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600">Type</dt>
                  <dd className="text-sm text-gray-900">{event.type}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600">Category</dt>
                  <dd className="text-sm">
                    <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-medium">
                      {event.category}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600">Severity</dt>
                  <dd className="text-sm">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        event.severity === 'critical'
                          ? 'bg-red-800 text-white'
                          : event.severity === 'error'
                          ? 'bg-red-100 text-red-800'
                          : event.severity === 'warning'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {event.severity}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600">Timestamp</dt>
                  <dd className="text-sm text-gray-900">
                    {formatTimestamp(event.timestamp)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Description */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                Description
              </h4>
              <p className="text-sm text-gray-700">{event.description}</p>
            </div>

            {/* Entity Info */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3">
                Entity
              </h4>
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-gray-600">Type</dt>
                  <dd className="text-sm text-gray-900">{event.entity_type}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600">ID</dt>
                  <dd className="text-sm font-mono text-gray-900 break-all">
                    {event.entity_id}
                  </dd>
                </div>
                {event.entity_name && (
                  <div>
                    <dt className="text-xs text-gray-600">Name</dt>
                    <dd className="text-sm text-gray-900">{event.entity_name}</dd>
                  </div>
                )}
              </dl>
            </div>

            {/* Actor Info */}
            {(event.actor_id || event.actor_name) && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3">
                  Actor (Who)
                </h4>
                <dl className="space-y-3">
                  {event.actor_id && (
                    <div>
                      <dt className="text-xs text-gray-600">ID</dt>
                      <dd className="text-sm font-mono text-gray-900 break-all">
                        {event.actor_id}
                      </dd>
                    </div>
                  )}
                  {event.actor_name && (
                    <div>
                      <dt className="text-xs text-gray-600">Name</dt>
                      <dd className="text-sm text-gray-900">{event.actor_name}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            {/* Event Data */}
            {event.data && Object.keys(event.data).length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3">
                  Event Data
                </h4>
                <dl className="space-y-3">
                  {Object.entries(event.data).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-xs text-gray-600">{key}</dt>
                      <dd className="text-sm text-gray-900 font-mono break-all">
                        {renderValue(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Metadata */}
            {event.metadata && Object.keys(event.metadata).length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3">
                  Metadata
                </h4>
                <dl className="space-y-3">
                  {Object.entries(event.metadata).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-xs text-gray-600">{key}</dt>
                      <dd className="text-sm text-gray-900 font-mono break-all">
                        {renderValue(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
