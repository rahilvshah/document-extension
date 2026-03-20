import React, { useEffect } from 'react';
import { getScreenshotUrl } from '../api/client.js';

interface ScreenshotViewerProps {
  screenshotId: string;
  onClose: () => void;
}

export default function ScreenshotViewer({ screenshotId, onClose }: ScreenshotViewerProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div className="relative max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
        <img
          src={getScreenshotUrl(screenshotId)}
          alt="Screenshot"
          className="max-w-full max-h-[85vh] rounded-xl shadow-[0_18px_60px_rgba(0,0,0,0.35)] border border-slate-200"
        />
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-9 h-9 bg-white/90 backdrop-blur border border-slate-200 rounded-full text-slate-600 hover:text-slate-900 hover:bg-white flex items-center justify-center transition-colors cursor-pointer"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
