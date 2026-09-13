import React, { useEffect, useId, useRef, useState } from 'react';
export function Dialog({ title, children, onClose, busy = false, drawer = false }: { title: string; children: React.ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  useEffect(() => { const el = ref.current!; el.showModal(); return () => el.close(); }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(onClose, 180);
    return () => window.clearTimeout(timer);
  }, [closing, onClose]);
  const close = () => { if (!busy) setClosing(true); };
  return <dialog ref={ref} className={'creator-modal app-dialog' + (drawer ? ' upload-drawer' : '') + (closing ? ' dialog-closing' : '')} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    }}>
    <div className="modal-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-btn" aria-label="关闭弹窗" disabled={busy} onClick={close}>×</button></div>
    {children}
  </dialog>;
}
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose }: { title: string; children: React.ReactNode; confirmLabel: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={title} busy={busy} onClose={onClose}>
    <div className="modal-body"><p className="confirm-copy">{children}</p>{error && <p className="error" role="alert">{error}</p>}</div>
    <div className="modal-foot"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn danger" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await onConfirm(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); setBusy(false); }
    }}>{busy ? '正在处理…' : confirmLabel}</button></div>
  </Dialog>;
}
