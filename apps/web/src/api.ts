import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  let response: Response;
  try { response = await fetch('/api/v1' + url, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  }); } catch { throw new Error('无法连接服务，请检查网络或稍后重试'); }
  if (response.status === 204) return undefined as T;
  const fallback = response.status >= 500 ? '后台服务暂不可用，请稍后重试' : '请求失败（HTTP ' + response.status + '）';
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error(response.ok ? '服务返回了无效数据，请稍后重试' : fallback); }
  if (!response.ok) {
    const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === 'string' && message ? message : fallback);
  }
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
