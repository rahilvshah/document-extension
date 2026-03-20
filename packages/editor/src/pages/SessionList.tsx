import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listSessions, deleteSession } from '../api/client.js';
import ConfirmModal from '../components/ConfirmModal.js';
import type { Session } from '@docext/shared';

export default function SessionList() {
  const queryClient = useQueryClient();
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['sessions'],
    queryFn: listSessions,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });

  if (isLoading) {
    return <div className="text-slate-400">Loading sessions...</div>;
  }

  if (error) {
    return (
      <div className="text-red-400">
        Failed to load sessions. Make sure the backend is running on port 3001.
      </div>
    );
  }

  const sessions = data?.sessions ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Recorded Sessions</h1>
        <span className="text-sm text-slate-500">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
      </div>

      {sessions.length === 0 ? (
        <div className="border border-dashed border-slate-200 rounded-xl p-12 text-center bg-white">
          <p className="text-slate-500 mb-2">No recordings yet</p>
          <p className="text-slate-600 text-sm">
            Start a recording from the browser extension to see sessions here.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onDelete={() => setDeleteSessionId(session.id)}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!deleteSessionId}
        title="Delete Session"
        message="Delete this session permanently? This action cannot be undone."
        confirmLabel={deleteMutation.isPending ? 'Deleting...' : 'Delete'}
        onCancel={() => setDeleteSessionId(null)}
        onConfirm={() => {
          if (!deleteSessionId || deleteMutation.isPending) return;
          deleteMutation.mutate(deleteSessionId, {
            onSettled: () => setDeleteSessionId(null),
          });
        }}
      />
    </div>
  );
}

function SessionCard({
  session,
  onDelete,
}: {
  session: Session & { stepCount: number };
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-4 bg-white border border-slate-200 rounded-2xl p-4 hover:border-indigo-400/40 hover:shadow-[0_8px_30px_rgba(99,102,241,0.10)] transition-colors">
      <Link
        to={`/session/${session.id}`}
        className="flex-1 min-w-0 no-underline"
      >
        <div className="font-medium text-slate-900 truncate">
          {session.title}
        </div>
        <div className="text-sm text-slate-600 mt-1 flex gap-3">
          <span>{new Date(session.createdAt).toLocaleDateString()}</span>
          <span>{session.stepCount} step{session.stepCount !== 1 ? 's' : ''}</span>
        </div>
      </Link>
      <button
        onClick={(e) => {
          e.preventDefault();
          onDelete();
        }}
        className="text-slate-600 hover:text-red-500 transition-colors p-2"
        title="Delete session"
      >
        ✕
      </button>
    </div>
  );
}
