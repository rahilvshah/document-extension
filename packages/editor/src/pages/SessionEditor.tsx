import React, { useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  getSession,
  updateSteps,
  updateSessionTitle,
  deleteSession,
} from '../api/client.js';
import StepCard from '../components/StepCard.js';
import ExportPanel from '../components/ExportPanel.js';
import ScreenshotViewer from '../components/ScreenshotViewer.js';
import ConfirmModal from '../components/ConfirmModal.js';
import type { Step } from '@docext/shared';

export default function SessionEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [viewScreenshot, setViewScreenshot] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Keep a local mirror of steps so edits are instant
  const [localSteps, setLocalSteps] = useState<Step[] | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['session', id],
    queryFn: () => getSession(id!),
    enabled: !!id,
  });

  const serverSteps = data?.steps ?? [];
  const steps = localSteps ?? serverSteps;

  const pendingStepsRef = useRef<{ steps: Step[]; deletedStepIds?: string[] } | null>(null);

  const updateMutation = useMutation({
    mutationFn: (args: { steps: Step[]; deletedStepIds?: string[] }) =>
      updateSteps(id!, {
        steps: args.steps.map((s, i) => ({
          id: s.id,
          sortOrder: i,
          title: s.title,
          description: s.description,
        })),
        deletedStepIds: args.deletedStepIds,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['session', id], (old: typeof data) =>
        old ? { ...old, steps: result.steps } : old
      );
      setLocalSteps(null);
      setSaveError(null);
    },
    onError: (err) => {
      console.error('Step update failed:', err);
      setSaveError('Failed to save — try again');
      setLocalSteps(null);
    },
  });

  const flushUpdate = useCallback((args: { steps: Step[]; deletedStepIds?: string[] }) => {
    pendingStepsRef.current = null;
    setLocalSteps(args.steps);
    updateMutation.mutate(args);
  }, [updateMutation]);

  const titleMutation = useMutation({
    mutationFn: (title: string) => updateSessionTitle(id!, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['session', id] }),
    onError: (err) => {
      console.error('Title update failed:', err);
      setSaveError('Failed to save title');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(id!),
    onSuccess: () => navigate('/'),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Stable callbacks that don't change on every render
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const currentSteps = pendingStepsRef.current?.steps ?? localSteps ?? serverSteps;
      const oldIndex = currentSteps.findIndex((s) => s.id === active.id);
      const newIndex = currentSteps.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...currentSteps];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      flushUpdate({ steps: reordered });
    },
    [localSteps, serverSteps, flushUpdate]
  );

  const handleStepUpdate = useCallback(
    (stepId: string, field: 'title' | 'description', value: string) => {
      const currentSteps = pendingStepsRef.current?.steps ?? localSteps ?? serverSteps;
      const updated = currentSteps.map((s) =>
        s.id === stepId ? { ...s, [field]: value } : s
      );
      flushUpdate({ steps: updated });
    },
    [localSteps, serverSteps, flushUpdate]
  );

  const handleStepDelete = useCallback(
    (stepId: string) => {
      const currentSteps = pendingStepsRef.current?.steps ?? localSteps ?? serverSteps;
      const remaining = currentSteps.filter((s) => s.id !== stepId);
      flushUpdate({ steps: remaining, deletedStepIds: [stepId] });
    },
    [localSteps, serverSteps, flushUpdate]
  );

  const handleScreenshotClick = useCallback(
    (screenshotId: string) => setViewScreenshot(screenshotId),
    []
  );

  const handleCloseViewer = useCallback(() => setViewScreenshot(null), []);

  const handleTitleSave = () => {
    if (titleDraft.trim()) {
      titleMutation.mutate(titleDraft.trim());
    }
    setEditingTitle(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-slate-500 text-sm">Loading session...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-red-400 text-sm">Session not found or failed to load.</div>
      </div>
    );
  }

  const { session } = data;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Save error banner */}
      {saveError && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center justify-between">
          <span>{saveError}</span>
          <button
            onClick={() => setSaveError(null)}
            className="text-red-500 hover:text-red-700 bg-transparent border-none cursor-pointer ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="mb-8 bg-white/80 border border-slate-200 rounded-2xl p-6 shadow-sm backdrop-blur">
        <button
          onClick={() => navigate('/')}
          className="text-slate-600 hover:text-slate-800 text-sm mb-4 inline-flex items-center gap-1 bg-transparent border-none cursor-pointer p-0"
        >
          ← Back to sessions
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleSave();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                className="text-2xl font-bold bg-white text-slate-900 border border-slate-300 rounded-lg px-3 py-1 w-full outline-none focus:border-indigo-500"
              />
            ) : (
              <h1
                className="text-2xl font-bold cursor-pointer hover:text-indigo-600 transition-colors"
                onClick={() => {
                  setTitleDraft(session.title);
                  setEditingTitle(true);
                }}
                title="Click to edit title"
              >
                {session.title}
              </h1>
            )}
            <div className="flex items-center gap-3 mt-1.5">
              <p className="text-sm text-slate-500">
                {new Date(session.createdAt).toLocaleString()} · {steps.length} step{steps.length !== 1 ? 's' : ''}
              </p>
              {updateMutation.isPending && (
                <span className="text-xs text-indigo-600">Saving...</span>
              )}
            </div>
          </div>

          <div className="flex gap-2 flex-shrink-0 pt-1">
            <ExportPanel sessionId={id!} />
            <button
              onClick={() => setShowDeleteModal(true)}
              className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white border border-red-500 rounded-lg text-sm transition-colors cursor-pointer"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Steps */}
      {steps.length === 0 ? (
        <div className="border border-dashed border-slate-200 rounded-xl p-12 text-center bg-white/60">
          <p className="text-slate-500">No steps generated yet</p>
          <p className="text-slate-600 text-sm mt-1">Steps are generated when a recording is finalized.</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-6">
              {steps.map((step, index) => (
                <StepCard
                  key={step.id}
                  step={step}
                  index={index}
                  onUpdate={handleStepUpdate}
                  onDelete={handleStepDelete}
                  onScreenshotClick={handleScreenshotClick}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {viewScreenshot && (
        <ScreenshotViewer
          screenshotId={viewScreenshot}
          onClose={handleCloseViewer}
        />
      )}

      <ConfirmModal
        open={showDeleteModal}
        title="Delete Session"
        message="Delete this session permanently? This action cannot be undone."
        confirmLabel={deleteMutation.isPending ? 'Deleting...' : 'Delete'}
        onCancel={() => setShowDeleteModal(false)}
        onConfirm={() => {
          if (deleteMutation.isPending) return;
          setShowDeleteModal(false);
          deleteMutation.mutate();
        }}
      />
    </div>
  );
}
