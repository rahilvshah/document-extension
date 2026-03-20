import React, { useState, memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getScreenshotUrl } from '../api/client.js';
import type { Step } from '@docext/shared';

interface StepCardProps {
  step: Step;
  index: number;
  onUpdate: (stepId: string, field: 'title' | 'description', value: string) => void;
  onDelete: (stepId: string) => void;
  onScreenshotClick: (screenshotId: string) => void;
}

export default memo(function StepCard({
  step,
  index,
  onUpdate,
  onDelete,
  onScreenshotClick,
}: StepCardProps) {
  const [editingField, setEditingField] = useState<'title' | 'description' | null>(null);
  const [draft, setDraft] = useState('');

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const startEditing = (field: 'title' | 'description') => {
    setDraft(field === 'title' ? step.title : step.description);
    setEditingField(field);
  };

  const saveEditing = () => {
    if (editingField && draft !== step[editingField]) {
      onUpdate(step.id, editingField, draft);
    }
    setEditingField(null);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative bg-white/80 border border-slate-200 rounded-2xl overflow-hidden hover:border-indigo-400/40 hover:shadow-[0_8px_30px_rgba(99,102,241,0.10)] transition-all"
    >
      {/* Top bar: step number + title + actions */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200/60 bg-white/60">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-700 select-none text-lg leading-none"
          title="Drag to reorder"
        >
          ⠿
        </div>

        <span className="w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-600 text-xs font-bold flex items-center justify-center flex-shrink-0">
          {index + 1}
        </span>

        <div className="flex-1 min-w-0">
          {editingField === 'title' ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveEditing}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEditing();
                if (e.key === 'Escape') setEditingField(null);
              }}
              className="w-full bg-white text-slate-900 border border-slate-300 rounded-md px-2 py-1 text-sm font-semibold outline-none focus:border-indigo-500"
            />
          ) : (
            <div
              role="button"
              tabIndex={0}
              className="font-semibold text-sm text-slate-900 cursor-pointer hover:text-indigo-600 transition-colors truncate"
              onClick={() => startEditing('title')}
              onKeyDown={(e) => { if (e.key === 'Enter') startEditing('title'); }}
              title="Click to edit"
            >
              {step.title || 'Untitled step'}
            </div>
          )}
        </div>

        <button
          onClick={() => onDelete(step.id)}
          className="text-red-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all bg-transparent border-none cursor-pointer p-1 text-sm"
          title="Delete step"
        >
          ✕
        </button>
      </div>

      {/* Screenshots — side by side when both themes available */}
      {step.screenshotId && (
        <div
          className={`bg-slate-100 ${step.altScreenshotId ? 'grid grid-cols-2 gap-px' : ''}`}
        >
          <div className="cursor-pointer relative" onClick={() => onScreenshotClick(step.screenshotId!)}>
            {step.altScreenshotId && (
              <span className="absolute top-2 left-2 bg-white/80 text-[10px] text-slate-700 px-1.5 py-0.5 rounded font-medium tracking-wide uppercase border border-slate-200">
                Light
              </span>
            )}
            <img
              src={getScreenshotUrl(step.screenshotId)}
              alt={`Step ${index + 1}`}
              className="w-full max-h-[400px] object-contain"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
          {step.altScreenshotId && (
            <div className="cursor-pointer relative" onClick={() => onScreenshotClick(step.altScreenshotId!)}>
              <span className="absolute top-2 left-2 bg-white/80 text-[10px] text-slate-700 px-1.5 py-0.5 rounded font-medium tracking-wide uppercase border border-slate-200">
                Dark
              </span>
              <img
                src={getScreenshotUrl(step.altScreenshotId)}
                alt={`Step ${index + 1} (dark)`}
                className="w-full max-h-[400px] object-contain"
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}
        </div>
      )}

      {/* Description below screenshot */}
      <div className="px-4 py-3">
        {editingField === 'description' ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveEditing}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingField(null);
            }}
            rows={2}
            className="w-full bg-white text-slate-700 border border-slate-300 rounded-md px-2 py-1.5 text-sm outline-none focus:border-indigo-500 resize-none"
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            className="text-sm text-slate-600 cursor-pointer hover:text-slate-700 transition-colors"
            onClick={() => startEditing('description')}
            onKeyDown={(e) => { if (e.key === 'Enter') startEditing('description'); }}
            title="Click to add description"
          >
            {step.description || 'Add a description...'}
          </div>
        )}
      </div>
    </div>
  );
});
