import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import SessionList from './pages/SessionList.js';
import SessionEditor from './pages/SessionEditor.js';

import { getLogoSvgMarkup } from '@docext/shared';

const logoSvg28 = getLogoSvgMarkup(28);

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/70 px-6 py-4 backdrop-blur">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center shadow-[0_2px_12px_rgba(99,102,241,0.18)]">
          <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: logoSvg28 }} />
          </div>
          <a href="/" className="text-xl font-bold tracking-tight text-indigo-500 hover:text-indigo-600 no-underline">
            DocExt
          </a>
          <span className="text-slate-600 text-sm">Documentation Editor</span>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Routes>
          <Route path="/" element={<SessionList />} />
          <Route path="/session/:id" element={<SessionEditor />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
