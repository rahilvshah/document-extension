import React from 'react';
import { getExportUrl } from '../api/client.js';

interface ExportPanelProps {
  sessionId: string;
}

export default function ExportPanel({ sessionId }: ExportPanelProps) {
  return (
    <a
      href={getExportUrl(sessionId)}
      download
      className="inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors no-underline"
    >
      Export ZIP
    </a>
  );
}