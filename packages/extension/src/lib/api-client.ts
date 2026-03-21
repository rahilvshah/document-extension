import type { RecordedEvent } from '@docext/shared';

const BASE_URL = 'http://localhost:3001/api';

export async function createSession(startUrl: string, title?: string) {
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startUrl, title }),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  return res.json();
}

export async function uploadEvents(sessionId: string, events: RecordedEvent[]) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`Upload events failed: ${res.status}`);
  return res.json();
}

export async function uploadScreenshotBlob(
  sessionId: string,
  blob: Blob
): Promise<string> {
  const formData = new FormData();
  formData.append('screenshot', blob, 'screenshot.webp');

  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/screenshots`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload screenshot failed: ${res.status}`);
  const data = await res.json();
  return data.screenshotId;
}

export async function finalizeSession(sessionId: string) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/finalize`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Finalize session failed: ${res.status}`);
  return res.json();
}

export async function deleteSession(sessionId: string) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Delete session failed: ${res.status}`);
  return res.json();
}
