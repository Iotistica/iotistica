/**
 * Audit Filters Sidebar
 * Left panel for filtering audit events
 */

import React from 'react';
import type { AuditFilters, AuditCategory, AuditSeverity } from './types';

interface AuditFiltersProps {
  filters: AuditFilters;
  onChange: (filters: AuditFilters) => void;
  stats?: {
    totalEvents: number;
    categoryBreakdown: Record<string, number>;
  };
}

export const AuditFiltersSidebar: React.FC<AuditFiltersProps> = ({
  filters,
  onChange,
  stats,
}) => {
  const toggleCategory = (category: AuditCategory) => {
    const newCategories = filters.categories.includes(category)
      ? filters.categories.filter((c) => c !== category)
      : [...filters.categories, category];
    onChange({ ...filters, categories: newCategories });
  };

  const toggleSeverity = (severity: AuditSeverity) => {
    const newSeverity = filters.severity.includes(severity)
      ? filters.severity.filter((s) => s !== severity)
      : [...filters.severity, severity];
    onChange({ ...filters, severity: newSeverity });
  };

  const handleDateChange = (field: 'start' | 'end', value: string) => {
    onChange({
      ...filters,
      dateRange: {
        ...filters.dateRange,
        [field]: value ? new Date(value) : null,
      },
    });
  };

  const clearAllFilters = () => {
    onChange({
      dateRange: { start: null, end: null },
      categories: [],
      eventTypes: [],
      severity: [],
      entitySearch: '',
      actorSearch: '',
    });
  };

  const categories: Array<{ key: AuditCategory; label: string; icon: string }> = [
    { key: 'device', label: 'Device Events', icon: '🔌' },
    { key: 'user', label: 'User Actions', icon: '👤' },
    { key: 'system', label: 'System Events', icon: '⚙️' },
    { key: 'mqtt', label: 'MQTT Activity', icon: '📡' },
    { key: 'security', label: 'Security Audit', icon: '🔒' },
    { key: 'billing', label: 'Billing Events', icon: '💳' },
  ];

  const severityLevels: Array<{ key: AuditSeverity; label: string; color: string }> = [
    { key: 'info', label: 'Info', color: 'text-blue-600' },
    { key: 'warning', label: 'Warning', color: 'text-yellow-600' },
    { key: 'error', label: 'Error', color: 'text-red-600' },
    { key: 'critical', label: 'Critical', color: 'text-red-800' },
  ];

  return (
    <div className="w-64 bg-white border-r border-gray-200 h-full overflow-y-auto p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Filters</h3>
        <button
          onClick={clearAllFilters}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Clear All
        </button>
      </div>

      {/* Stats Summary */}
      {stats && (
        <div className="mb-4 p-3 bg-gray-50 rounded-lg">
          <div className="text-2xl font-bold text-gray-900">{stats.totalEvents}</div>
          <div className="text-xs text-gray-600">Total Events</div>
        </div>
      )}

      {/* Category Filter */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-700 mb-2">Category</h4>
        <div className="space-y-2">
          {categories.map((cat) => (
            <label key={cat.key} className="flex items-center cursor-pointer hover:bg-gray-50 p-1 rounded">
              <input
                type="checkbox"
                checked={filters.categories.includes(cat.key)}
                onChange={() => toggleCategory(cat.key)}
                className="mr-2 h-4 w-4 text-blue-600 rounded"
              />
              <span className="mr-2">{cat.icon}</span>
              <span className="text-sm text-gray-700 flex-1">{cat.label}</span>
              {stats?.categoryBreakdown[cat.key] && (
                <span className="text-xs text-gray-500">
                  {stats.categoryBreakdown[cat.key]}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>

      {/* Severity Filter */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-700 mb-2">Severity</h4>
        <div className="space-y-2">
          {severityLevels.map((sev) => (
            <label key={sev.key} className="flex items-center cursor-pointer hover:bg-gray-50 p-1 rounded">
              <input
                type="checkbox"
                checked={filters.severity.includes(sev.key)}
                onChange={() => toggleSeverity(sev.key)}
                className="mr-2 h-4 w-4 text-blue-600 rounded"
              />
              <span className={`text-sm font-medium ${sev.color}`}>{sev.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Date Range Filter */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-700 mb-2">Date Range</h4>
        <div className="space-y-2">
          <div>
            <label className="text-xs text-gray-600">From</label>
            <input
              type="datetime-local"
              value={filters.dateRange.start?.toISOString().slice(0, 16) || ''}
              onChange={(e) => handleDateChange('start', e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1 mt-1"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">To</label>
            <input
              type="datetime-local"
              value={filters.dateRange.end?.toISOString().slice(0, 16) || ''}
              onChange={(e) => handleDateChange('end', e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1 mt-1"
            />
          </div>
        </div>
      </div>

      {/* Entity Search */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-700 mb-2">Entity Search</h4>
        <input
          type="text"
          placeholder="Device ID, name..."
          value={filters.entitySearch}
          onChange={(e) => onChange({ ...filters, entitySearch: e.target.value })}
          className="w-full text-sm border border-gray-300 rounded px-3 py-2"
        />
      </div>

      {/* Actor Search */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-700 mb-2">Actor Search</h4>
        <input
          type="text"
          placeholder="User email..."
          value={filters.actorSearch}
          onChange={(e) => onChange({ ...filters, actorSearch: e.target.value })}
          className="w-full text-sm border border-gray-300 rounded px-3 py-2"
        />
      </div>
    </div>
  );
};
