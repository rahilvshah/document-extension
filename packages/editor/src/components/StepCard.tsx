import React, { useState, memo, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getScreenshotUrl } from '../api/client.js';
import type { Step } from '@docext/shared';

export interface StepMergeAction {
  /** Steps combined when Merge is clicked, trigger first. */
  groupIds: string[];
  /** Step ids whose merge link is cleared by Keep separate. */
  keepSeparateIds: string[];
  /** Visible label, including which neighbor is combined. */
  label: string;
  title: string;
  onMerge: (groupIds: string[]) => Promise<void>;
  onKeepSeparate: (groupIds: string[]) => Promise<void>;
}

interface StepCardProps {
  step: Step;
  index: number;
  onUpdate: (stepId: string, field: 'title' | 'description', value: string) => void;
  onDelete: (stepId: string) => void;
  onScreenshotClick: (screenshotId: string) => void;
  mergeAction?: StepMergeAction;
}

type FrameTab = 'annotated' | 'clean';
type MomentTab = 'before' | 'after' | 'both';
type ThemeTab = 'light' | 'dark' | 'both';

interface ShotPair {
  light?: string;
  dark?: string;
}

export default memo(function StepCard({
  step,
  index,
  onUpdate,
  onDelete,
  onScreenshotClick,
  mergeAction,
}: StepCardProps) {
  const [editingField, setEditingField] = useState<'title' | 'description' | null>(null);
  const [draft, setDraft] = useState('');
  const hasAnnotation = !!(step.highlights?.some(
    (h) => !h.skip && h.rect.width >= 2 && h.rect.height >= 2,
  ));
  const [frame, setFrame] = useState<FrameTab>(hasAnnotation ? 'annotated' : 'clean');
  const [moment, setMoment] = useState<MomentTab>(
    step.afterLightId || step.afterDarkId || step.annotatedAfterLightId || step.annotatedAfterDarkId
      ? 'both'
      : 'before',
  );
  const [mergeBusy, setMergeBusy] = useState<'merge' | 'keep' | null>(null);
  const hasDark = !!(
    step.altScreenshotId || step.beforeDarkId || step.afterDarkId || step.annotatedAfterDarkId
  );
  const [theme, setTheme] = useState<ThemeTab>(hasDark ? 'both' : 'light');

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

  const activeFrame: FrameTab = hasAnnotation ? frame : 'clean';
  const hasClean = !!(step.beforeLightId || step.beforeDarkId);
  const hasResult = !!(
    step.afterLightId || step.afterDarkId || step.annotatedAfterLightId || step.annotatedAfterDarkId
  );
  const showDark = hasDark;

  const shots = useMemo(() => {
    const annotatedBefore: ShotPair = {
      light: step.screenshotId,
      dark: showDark ? step.altScreenshotId : undefined,
    };
    const annotatedAfter: ShotPair = {
      light: step.annotatedAfterLightId || step.afterLightId,
      dark: showDark ? (step.annotatedAfterDarkId || step.afterDarkId) : undefined,
    };
    const cleanBefore: ShotPair = {
      light: step.beforeLightId || step.screenshotId,
      dark: showDark ? (step.beforeDarkId || step.altScreenshotId) : undefined,
    };
    const cleanAfter: ShotPair = {
      light: step.afterLightId,
      dark: showDark ? step.afterDarkId : undefined,
    };
    return activeFrame === 'clean'
      ? { before: cleanBefore, after: cleanAfter }
      : { before: annotatedBefore, after: annotatedAfter };
  }, [activeFrame, step, showDark]);

  const visibleMoments: Array<'before' | 'after'> =
    moment === 'both' && hasResult ? ['before', 'after'] : moment === 'after' && hasResult ? ['after'] : ['before'];

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

  const segmentBtn = (active: boolean) =>
    `px-2.5 py-1 text-[11px] font-medium border-0 cursor-pointer transition-colors ${
      active ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
    }`;

  const renderShot = (id: string | undefined, caption: string | undefined) => {
    if (!id) return null;
    return (
      <button
        type="button"
        className="block w-full text-left bg-slate-100 cursor-pointer border-0 p-0"
        onClick={() => onScreenshotClick(id)}
      >
        {caption && (
          <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {caption}
          </div>
        )}
        <img
          src={getScreenshotUrl(id)}
          alt={`Step ${index + 1} ${caption || 'screenshot'}`}
          className="w-full max-h-[420px] object-contain bg-slate-100"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      </button>
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative bg-white/80 border border-slate-200 rounded-2xl overflow-hidden hover:border-indigo-400/40 hover:shadow-[0_8px_30px_rgba(99,102,241,0.10)] transition-all"
    >
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

      {mergeAction && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-amber-200/80 bg-amber-50">
          <p className="text-xs text-amber-950">{mergeAction.title}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!!mergeBusy}
              title={mergeAction.title}
              onClick={() => {
                setMergeBusy('merge');
                void mergeAction.onMerge(mergeAction.groupIds).finally(() => setMergeBusy(null));
              }}
              className="px-2.5 py-1 rounded-md bg-amber-700 text-white text-xs font-medium border-0 cursor-pointer disabled:opacity-60"
            >
              {mergeBusy === 'merge' ? 'Merging…' : mergeAction.label}
            </button>
            <button
              type="button"
              disabled={!!mergeBusy}
              title="Keep these steps separate"
              onClick={() => {
                setMergeBusy('keep');
                void mergeAction.onKeepSeparate(mergeAction.keepSeparateIds).finally(() => setMergeBusy(null));
              }}
              className="px-2.5 py-1 rounded-md bg-white text-amber-950 text-xs font-medium border border-amber-300 cursor-pointer disabled:opacity-60"
            >
              {mergeBusy === 'keep' ? 'Saving…' : 'Keep separate'}
            </button>
          </div>
        </div>
      )}

      {(hasAnnotation || hasResult || (showDark && (shots.before.dark || shots.after.dark || step.altScreenshotId))) && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 border-b border-slate-200/60 bg-slate-50/80">
          {hasAnnotation && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Highlights</span>
              <div className="flex overflow-hidden rounded-md border border-slate-200">
                <button type="button" className={segmentBtn(frame === 'annotated')} onClick={() => setFrame('annotated')}>
                  Annotated
                </button>
                <button
                  type="button"
                  className={`${segmentBtn(activeFrame === 'clean')} border-l border-slate-200`}
                  onClick={() => setFrame('clean')}
                  disabled={!hasClean && !step.screenshotId}
                >
                  Clean
                </button>
              </div>
            </div>
          )}
          {hasResult && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Moment</span>
              <div className="flex overflow-hidden rounded-md border border-slate-200">
                {(['before', 'after', 'both'] as const).map((value, i) => (
                  <button
                    key={value}
                    type="button"
                    className={`${segmentBtn(moment === value)} ${i > 0 ? 'border-l border-slate-200' : ''}`}
                    onClick={() => setMoment(value)}
                  >
                    {value === 'before' ? 'Before' : value === 'after' ? 'After' : 'Both'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {showDark && (shots.before.dark || shots.after.dark || step.altScreenshotId) && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Theme</span>
              <div className="flex overflow-hidden rounded-md border border-slate-200">
                {(['light', 'dark', 'both'] as const).map((value, i) => (
                  <button
                    key={value}
                    type="button"
                    className={`${segmentBtn(theme === value)} ${i > 0 ? 'border-l border-slate-200' : ''}`}
                    onClick={() => setTheme(value)}
                  >
                    {value === 'light' ? 'Light' : value === 'dark' ? 'Dark' : 'Both'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {visibleMoments.some((m) => shots[m].light || shots[m].dark) && (
        <div className="flex flex-col">
          {visibleMoments.map((which) => {
            const pair = shots[which];
            const themeBoth = theme === 'both' && !!pair.dark;
            const showLight = theme === 'light' || theme === 'both' || !pair.dark;
            const showDarkShot = (theme === 'dark' || theme === 'both') && !!pair.dark;
            return (
              <section key={which} className="border-b border-slate-200/70 last:border-b-0">
                {visibleMoments.length > 1 && (
                  <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 bg-white">
                    {which === 'before' ? 'Before' : 'After'}
                  </div>
                )}
                <div className={themeBoth ? 'grid grid-cols-2 gap-px bg-slate-200' : ''}>
                  {showLight && renderShot(pair.light, themeBoth ? 'Light' : undefined)}
                  {showDarkShot && renderShot(pair.dark, themeBoth ? 'Dark' : undefined)}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {step.subSteps && step.subSteps.length > 0 && (
        <div className="px-4 py-3 border-b border-slate-200/60">
          <ol className="space-y-1.5">
            {step.subSteps.map((sub, subIdx) => (
              <li key={subIdx} className="flex items-start gap-2 text-sm">
                <span className="w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                  {subIdx + 1}
                </span>
                <span className="text-slate-700">{sub.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

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
