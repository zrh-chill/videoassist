import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/v1' + url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || '请求失败');
  return payload as T;
}
export function useEvents() {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let source: EventSource | undefined;
    const connect = () => {
      source?.close();
      if (document.hidden) { setConnected(false); return; }
      source = new EventSource('/api/v1/events?after=' + (sessionStorage.getItem('eventCursor') || '0'));
      source.onopen = () => { setConnected(true); void client.invalidateQueries({ queryKey: ['videos'] }); };
      source.onerror = () => setConnected(false);
      source.addEventListener('task', (event: MessageEvent) => {
        sessionStorage.setItem('eventCursor', event.lastEventId);
        const data = JSON.parse(event.data) as { videoId: string };
        void client.invalidateQueries({ queryKey: ['videos'] });
        void client.invalidateQueries({ queryKey: ['video', data.videoId] });
      });
    };
    connect();
    document.addEventListener('visibilitychange', connect);
    return () => { source?.close(); document.removeEventListener('visibilitychange', connect); };
  }, [client]);
  return connected;
}
