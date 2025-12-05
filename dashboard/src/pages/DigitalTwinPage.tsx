/**
 * Digital Twin Page
 * Visualizes building hierarchy from Neo4j graph database
 * with IFC file upload and device mapping capabilities8
 */

import React, { useState} from 'react';
import { Neo4jGraphVisualization } from '../components/Neo4jGraphVisualization';
import { Upload, FileText, CheckCircle, XCircle } from 'lucide-react';
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4002';

interface UploadStats {
  floors: number;
  spaces: number;
  relationships: number;
}

export const DigitalTwinPage: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    success: boolean;
    message: string;
    stats?: UploadStats;
  } | null>(null);
  const [graphKey, setGraphKey] = useState(0);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.ifc')) {
      setSelectedFile(file);
      setUploadResult(null);
    } else {
      alert('Please select a valid IFC file');
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setUploading(true);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const response = await axios.post(
        `${API_BASE_URL}/api/v1/digital-twin/graph/upload-ifc`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        }
      );

      setUploadResult({
        success: true,
        message: response.data.message || 'IFC file uploaded successfully',
        stats: response.data.stats,
      });

      // Refresh graph visualization
      setGraphKey((prev) => prev + 1);
      setSelectedFile(null);
    } catch (error: any) {
      console.error('Upload failed:', error);
      setUploadResult({
        success: false,
        message: error.response?.data?.message || error.message || 'Upload failed',
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="h-screen flex flex-col" style={{ background: '#0f0f0f' }}>
      {/* Header with Upload */}
      <div
        className="px-6 py-4 border-b flex items-center justify-between"
        style={{ borderColor: '#2d3748', background: '#1a1a1a' }}
      >
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#e2e8f0' }}>
            Digital Twin
          </h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Building hierarchy and device mapping
          </p>
        </div>

        {/* IFC Upload Section */}
        <div className="flex items-center gap-4">
          {selectedFile && (
            <div
              className="flex items-center gap-2 px-4 py-2 rounded-lg"
              style={{ background: '#2d3748' }}
            >
              <FileText className="w-4 h-4" style={{ color: '#94a3b8' }} />
              <span className="text-sm" style={{ color: '#e2e8f0' }}>
                {selectedFile.name}
              </span>
            </div>
          )}

          <label
            className="px-4 py-2 rounded-lg cursor-pointer text-sm font-medium transition-colors flex items-center gap-2"
            style={{
              background: '#2d3748',
              color: '#e2e8f0',
              border: '1px solid #4a5568',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#374151')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#2d3748')}
          >
            <Upload className="w-4 h-4" />
            Choose IFC File
            <input
              type="file"
              accept=".ifc"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>

          {selectedFile && (
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{
                background: '#4C8EDA',
                color: '#fff',
              }}
              onMouseEnter={(e) => !uploading && (e.currentTarget.style.background = '#5A9BE8')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#4C8EDA')}
            >
              {uploading ? 'Uploading...' : 'Upload & Parse'}
            </button>
          )}
        </div>
      </div>

      {/* Upload Result */}
      {uploadResult && (
        <div
          className="px-6 py-3 border-b flex items-center justify-between"
          style={{
            borderColor: '#2d3748',
            background: uploadResult.success ? '#1e3a1e' : '#3a1e1e',
          }}
        >
          <div className="flex items-center gap-3">
            {uploadResult.success ? (
              <CheckCircle className="w-5 h-5" style={{ color: '#4ade80' }} />
            ) : (
              <XCircle className="w-5 h-5" style={{ color: '#f87171' }} />
            )}
            <div>
              <p
                className="text-sm font-medium"
                style={{ color: uploadResult.success ? '#4ade80' : '#f87171' }}
              >
                {uploadResult.message}
              </p>
              {uploadResult.stats && (
                <p className="text-xs mt-1" style={{ color: '#94a3b8' }}>
                  Loaded {uploadResult.stats.floors} floors, {uploadResult.stats.spaces} spaces,{' '}
                  {uploadResult.stats.relationships} relationships
                </p>
              )}
            </div>
          </div>
          <button
            onClick={() => setUploadResult(null)}
            className="text-sm"
            style={{ color: '#94a3b8' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Graph Visualization */}
      <div className="flex-1 overflow-hidden">
        <Neo4jGraphVisualization key={graphKey} />
      </div>
    </div>
  );
};
