import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { Dialog } from './dialog';

export function VideoImport({ children, onAdded }: { children: React.ReactNode; onAdded: () => void }) {
  const client = useQueryClient();
  const [url, setUrl] = useState('');
  const [upload, setUpload] = useState(false);
  const [notice, setNotice] = useState('');
  const capability = useQuery({ queryKey: ['capabilities'], queryFn: () => api<{ uploadMaxBytes: number }>('/capabilities'), refetchInterval: false });
  const refresh = () => { onAdded(); void client.invalidateQueries({ queryKey: ['videos'] }); };
  const add = useMutation({ mutationFn: () => api<{ id: string; duplicate: boolean }>('/videos/bilibili', { url: url.trim() }),
    onSuccess: result => { setUrl(''); setNotice(result.duplicate ? '该视频已在任务列表中' : '视频任务已添加'); refresh(); } });
  return <>
    <div className="video-import-bar">
      <form className="link-import" onSubmit={event => { event.preventDefault(); setNotice(''); add.mutate(); }}>
        <input id="video-url" aria-label="视频链接" type="url" required placeholder="粘贴 B 站视频链接，支持 b23.tv 短链接" value={url} onChange={event => setUrl(event.target.value)} disabled={add.isPending}/>
        <button className="btn primary" disabled={add.isPending}>{add.isPending ? '正在添加…' : '＋ 添加视频'}</button>
      </form>
      <button className="btn" onClick={() => setUpload(true)}>↑ 本地上传</button>
      {children}
    </div>
    {add.error && <p className="error" role="alert">{add.error.message}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {upload && <UploadDrawer maxBytes={capability.data?.uploadMaxBytes} capabilityError={capability.error?.message} onClose={() => setUpload(false)} onDone={() => { setUpload(false); setNotice('本地视频已添加'); refresh(); }}/>}
  </>;
}
function UploadDrawer({ maxBytes, capabilityError, onClose, onDone }: { maxBytes?: number; capabilityError?: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  useEffect(() => () => { if (request.current) { request.current.onload = null; request.current.onerror = null; request.current.upload.onprogress = null; request.current.abort(); } }, []);
  const select = (files: FileList | null) => {
    if (pending || !files?.length) return;
    setError(''); setProgress(0); setFile(null);
    if (files.length !== 1) return setError('每次请选择一个视频文件');
    const next = files[0];
    if (!/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(next.name)) return setError('不支持此文件格式，请选择视频文件');
    if (!next.size) return setError('不能上传空文件');
    if (maxBytes && next.size > maxBytes) return setError('文件超过上传容量限制');
    setFile(next);
  };
  const submit = () => {
    if (!file || !maxBytes || pending) return;
    if (file.size > maxBytes) return setError('文件超过上传容量限制');
    setPending(true); setError(''); setProgress(0);
    const xhr = new XMLHttpRequest(); request.current = xhr;
    xhr.open('POST', '/api/v1/videos/uploads');
    xhr.setRequestHeader('Idempotency-Key', crypto.randomUUID());
    xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => { setError('上传连接失败，请检查网络后重试'); setPending(false); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(data.error?.message || '上传失败');
        onDone();
      } catch (e) { setError(e instanceof Error ? e.message : '上传响应异常'); setPending(false); }
    };
    const data = new FormData(); data.set('file', file); xhr.send(data);
  };
  return <Dialog drawer title="本地上传" busy={pending} onClose={onClose}>
    <div className="modal-body upload-body">
      <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="选择本地视频" accept=".mp4,.mov,.mkv,.webm,.avi,.m4v" disabled={pending} onChange={event => { select(event.target.files); event.target.value = ''; }}/>
      <button type="button" className={'upload-dropzone' + (dragging ? ' dragging' : '')} disabled={pending} onClick={() => input.current?.click()}
        onDragOver={event => { event.preventDefault(); if (!pending) setDragging(true); }}
        onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); select(event.dataTransfer.files); }}>
        <span className="upload-symbol" aria-hidden="true">↑</span><strong>{file ? '点击或拖拽替换视频' : '将视频拖拽到这里'}</strong><span>或点击选择本地文件</span>
      </button>
      {file && <div className="upload-file"><span aria-hidden="true">▣</span><div><strong>{file.name}</strong><small>{(file.size / 1024 ** 2).toFixed(2)} MiB</small></div><button className="icon-btn" aria-label="移除文件" disabled={pending} onClick={() => setFile(null)}>×</button></div>}
      <div className="upload-description"><h3>文件说明</h3><p>支持 MP4、MOV、MKV、WebM、AVI、M4V 格式。</p><p>{maxBytes ? '单个文件最大 ' + (maxBytes / 1024 ** 3).toFixed(2) + ' GiB，每次上传一个视频。' : capabilityError || '正在读取上传容量限制…'}</p><p>上传后会校验视频，并自动提取音频、转写和生成总结。</p></div>
      {pending && <div className="upload-progress" role="status"><progress value={progress} max={100}/><span>{progress < 100 ? '正在上传 ' + progress + '%' : '上传完成，正在校验视频…'}</span></div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="modal-foot"><button className="btn" disabled={pending} onClick={onClose}>取消</button><button className="btn primary" disabled={!file || !maxBytes || pending} onClick={submit}>{pending ? '正在上传…' : '开始上传'}</button></div>
  </Dialog>;
}
