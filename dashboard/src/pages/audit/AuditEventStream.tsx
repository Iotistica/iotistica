/**
 * Audit Event Stream
 * Center panel showing list of filtered events
 */

import React from 'react';
import type { AuditEvent } from './types';

interface AuditEventStreamProps {
  events: AuditEvent[];
  selectedEventId: string | null;
  onSelectEvent: (event: AuditEvent) => void;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

export const AuditEventStream: React.FC<AuditEventStreamProps> = ({
  events,
  selectedEventId,
  onSelectEvent,
  loading,
  hasMore,
  onLoadMore,
}) => {
  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
        return '🔴';
      case 'error':
        return '❌';
      case 'warning':
        return '⚠️';
      case 'info':
      default:
        return 'ℹ️';
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'device':
        return 'bg-blue-100 text-blue-800';
      case 'user':
        return 'bg-green-100 text-green-800';
      case 'system':
        return 'bg-purple-100 text-purple-800';
      case 'mqtt':
        return 'bg-orange-100 text-orange-800';
      case 'security':
        return 'bg-red-100 text-red-800';
      case 'billing':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="flex-1 bg-gray-50 overflow-y-auto">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 sticky top-0 z-10">
        <h2 className="text-lg font-semibold text-gray-900">Event Stream</h2>
        <p className="text-sm text-gray-600">{events.length} events</p>
      </div>

      {/* Event List */}
      <div className="p-4 space-y-2">
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">No events found</p>
            <p className="text-sm text-gray-400 mt-2">Try adjusting your filters</p>
          </div>
        ) : (
          <>
            {events.map((event) => (
              <div
                key={event.id}
                onClick={() => onSelectEvent(event)}
                className={`
                  bg-white rounded-lg border p-4 cursor-pointer transition-all
                  hover:shadow-md hover:border-blue-300
                  ${
                    selectedEventId === event.id
                      ? 'border-blue-500 shadow-md ring-2 ring-blue-200'
                      : 'border-gray-200'
                  }
                `}
              >
                <div className="flex items-start gap-3">
                  {/* Severity Icon */}
                  <div className="text-2xl mt-1">
                    {getSeverityIcon(event.severity)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${getCategoryColor(
                          event.category
                        )}`}
                      >
                        {event.category}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatTimestamp(event.timestamp)}
                      </span>
                    </div>

                    <h3 className="font-medium text-gray-900 mb-1">
                      {event.title}
                    </h3>

                    <p className="text-sm text-gray-600 line-clamp-2">
                      {event.description}
                    </p>

                    {/* Entity/Actor Info */}
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      {event.entity_name && (
                        <span>
                          <span className="font-medium">Entity:</span> {event.entity_name}
                        </span>
                      )}
                      {event.actor_name && (
                        <span>
                          <span className="font-medium">Actor:</span> {event.actor_name}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Chevron */}
                  <div className="text-gray-400">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            ))}

            {/* Load More Button */}
            {hasMore && (
              <button
                onClick={onLoadMore}
                disabled={loading}
                className="w-full py-3 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg border border-gray-200 disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load More Events'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
