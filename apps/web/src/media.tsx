import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { TranscriptDto, SummaryDto, StructuredSummary } from '../../../packages/contracts/src/media';

export const sourceName: Record<string, string> = { LOCAL: '本地视频', BILIBILI: 'B 站', SIMULATION: '模拟任务' };
export function AddVideoForm({ onDone, maxBytes }: { onDone: (id: string) => void; maxBytes: number }) {
  const [mode, setMode] = useState<'bilibili' | 'local'>('bilibili');
  const [progress, setProgress] = useState(0);
  const mutation = useMutation({ mutationFn: async (form: HTMLFormElement) => {
    const data = new FormData(form);
    if (mode === 'bilibili') return api<{ id: string }>('/videos/bilibili', { url: data.get('url') });
    const file = data.get('file') as File;
    if (!file?.size) throw new Error('请选择视频文件');
    if (file.size > maxBytes) throw new Error('文件超过上传容量限制');
    return new Promise<{ id: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/videos/uploads');
      xhr.setRequestHeader('Idempotency-Key', crypto.randomUUID());
      xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
      xhr.onerror = () => reject(new Error('上传连接失败，请检查网络后重试'));
      xhr.onload = () => {
        try {
          const result = JSON.parse(xhr.responseText);
          xhr.status < 300 ? resolve(result) : reject(new Error(result.error?.message || '上传失败'));
        } catch { reject(new Error('上传响应异常')); }
      };
      const upload = new FormData(); upload.set('file', file); xhr.send(upload);
    });
  }, onSuccess: data => onDone(data.id) });
  return <section className="panel">
    <div className="media-tabs"><button className={'btn ' + (mode === 'bilibili' ? 'primary' : '')} disabled={mutation.isPending} onClick={() => { setMode('bilibili'); mutation.reset(); }}>B 站链接</button>
      <button className={'btn ' + (mode === 'local' ? 'primary' : '')} disabled={mutation.isPending} onClick={() => { setMode('local'); mutation.reset(); }}>本地上传</button></div>
    <form className="media-import" onSubmit={event => { event.preventDefault(); setProgress(0); mutation.mutate(event.currentTarget); }}>
      {mode === 'bilibili' ? <label>B 站视频链接<input name="url" type="url" required placeholder="https://www.bilibili.com/video/BV…/" disabled={mutation.isPending}/><small>支持 BV 链接与 b23.tv 短链接，仅处理第一分 P；相同 BVID 会打开已有任务。</small></label>
        : <label>选择本地视频<input name="file" type="file" accept=".mp4,.mov,.mkv,.webm,.avi,.m4v" required disabled={mutation.isPending}/><small>支持常见视频格式，单文件最多 {(maxBytes / 1024 ** 3).toFixed(1)} GiB。</small></label>}
      {mutation.error && <p className="error" role="alert">{mutation.error.message}</p>}
      <button className="btn primary" disabled={mutation.isPending}>{mutation.isPending ? (mode === 'local' ? (progress < 100 ? '正在上传 ' + progress + '%' : '上传完成，正在校验…') : '正在创建任务…') : '开始处理'}</button>
    </form>
  </section>;
}
interface Version { id: string; revision: number; isCurrent: boolean }
interface Versioned<T> { current: T | null; versions: Version[] }
function VersionSelect({ label, value, versions, onChange }: { label: string; value: string; versions: Version[]; onChange: (value: string) => void }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
    <option value="">当前版本</option>{versions.map(version => <option key={version.id} value={version.revision}>版本 {version.revision}{version.isCurrent ? ' · 当前' : ''}</option>)}
  </select>;
}
function SummaryContent({ data }: { data: StructuredSummary }) {
  return <div className="summary-content"><p className="summary-lead">{data.one_sentence}</p><h3>核心要点</h3><ul>{data.key_points.map((point, index) => <li key={index}>{point}</li>)}</ul>
    {data.detailed_summary.split(/(?=^### )/m).map((section, index) => {
      const [heading, ...body] = section.split('\n');
      return <section key={index}>{heading?.startsWith('### ') ? <><h3>{heading.slice(4)}</h3><p>{body.join('\n').trim()}</p></> : <p>{section}</p>}</section>;
    })}<div className="keywords">{data.keywords.map(word => <span key={word}>{word}</span>)}</div></div>;
}
const stamp = (ms: number) => Math.floor(ms / 60000).toString().padStart(2, '0') + ':' + Math.floor(ms % 60000 / 1000).toString().padStart(2, '0');
export function MediaResults({ id, active }: { id: string; active: boolean }) {
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary');
  const [transcriptRevision, setTranscriptRevision] = useState('');
  const [summaryRevision, setSummaryRevision] = useState('');
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const transcript = useQuery({ queryKey: ['video', id, 'transcript', transcriptRevision],
    queryFn: () => api<Versioned<TranscriptDto>>('/videos/' + id + '/transcript' + (transcriptRevision ? '?revision=' + transcriptRevision : '')) });
  const summary = useQuery({ queryKey: ['video', id, 'summary', summaryRevision],
    queryFn: () => api<Versioned<SummaryDto>>('/videos/' + id + '/summary' + (summaryRevision ? '?revision=' + summaryRevision : '')) });
  const regenerate = useMutation({ mutationFn: () => api('/videos/' + id + '/actions/regenerate-summary', {}),
    onSuccess: () => { setSummaryRevision(''); setNotice('已创建总结任务，完成后自动显示新版本。'); void client.invalidateQueries({ queryKey: ['video', id] }); } });
  const text = transcript.data?.current;
  const result = summary.data?.current;
  const copy = async () => {
    try { await navigator.clipboard.writeText(tab === 'summary' ? result?.renderedText || '' : text?.fullText || ''); setNotice('已复制到剪贴板'); }
    catch { setNotice('复制失败，请选择正文手动复制。'); }
  };
  return <section className="panel results-panel">
    <div className="results-toolbar"><div className="media-tabs"><button className={'btn ' + (tab === 'summary' ? 'primary' : '')} onClick={() => setTab('summary')}>AI 总结</button><button className={'btn ' + (tab === 'transcript' ? 'primary' : '')} onClick={() => setTab('transcript')}>完整文稿</button></div>
      <div className="media-tabs"><VersionSelect label={tab === 'summary' ? '总结版本' : '文稿版本'} value={tab === 'summary' ? summaryRevision : transcriptRevision} versions={(tab === 'summary' ? summary.data : transcript.data)?.versions || []} onChange={tab === 'summary' ? setSummaryRevision : setTranscriptRevision}/>
        <button className="btn" disabled={tab === 'summary' ? !result : !text} onClick={() => { void copy(); }}>复制{tab === 'summary' ? '总结' : '文稿'}</button></div></div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {(transcript.error || summary.error || regenerate.error) && <p className="error" role="alert">{(transcript.error || summary.error || regenerate.error)?.message}</p>}
    {tab === 'summary' ? <>
      {result ? <><p className="result-meta">版本 {result.revision}{!result.isCurrent ? ' · 历史版本' : ''} · {result.model} · 提示词 {result.promptVersionId.slice(0, 8)}</p><SummaryContent data={JSON.parse(result.structuredJson) as StructuredSummary}/></> : <div className="empty">{summary.data?.versions.length ? '旧总结已转为历史版本，可通过版本菜单查看；新总结尚未完成。' : '总结尚未生成，完成转写后会自动开始。'}</div>}
      <button className="btn" disabled={!transcript.data?.versions.some(version => version.isCurrent) || active || regenerate.isPending} onClick={() => { if (window.confirm('重新调用模型生成总结，旧总结将转为历史版本。确认继续？')) regenerate.mutate(); }}>重新生成总结</button>
    </> : text ? <>
      <p className="result-meta">版本 {text.revision}{!text.isCurrent ? ' · 历史版本' : ''} · {text.model} · {text.timestampPrecision === 'CHUNK' ? '时间范围对应音频分片，不是逐句时间戳' : '带时间段落'}</p>
      <div className="transcript-content">{text.segments.map((segment, index) => <article key={index}><span className="mono">{stamp(segment.startMs)} — {stamp(segment.endMs)}</span><p>{segment.text}</p></article>)}</div>
    </> : <div className="empty">{transcript.data?.versions.length ? '旧文稿已转为历史版本，可通过版本菜单查看；新文稿尚未完成。' : '文稿尚未生成，正在等待音频转写。'}</div>}
  </section>;
}

export function ReprocessActions({ id, sourceType, active }: { id: string; sourceType: string; active: boolean }) {
  const client = useQueryClient();
  const [notice, setNotice] = useState('');
  const choices = [
    ...(sourceType === 'BILIBILI' ? [{ stage: 'FETCH', label: '重新下载', affected: '原视频、音频、文稿和总结' }] : []),
    { stage: 'EXTRACT_AUDIO', label: '重新提取音频', affected: '音频、文稿和总结' },
    { stage: 'TRANSCRIBE', label: '重新转写', affected: '文稿和总结' },
  ];
  const mutation = useMutation({ mutationFn: (choice: typeof choices[number]) => api('/videos/' + id + '/actions/reprocess', {
    stage: choice.stage, force: true, reason: '用户确认' + choice.label,
  }), onSuccess: () => { setNotice('已创建新任务，旧结果保留在历史版本中。'); void client.invalidateQueries({ queryKey: ['video', id] }); void client.invalidateQueries({ queryKey: ['videos'] }); } });
  return <section className="panel"><h2>重新处理</h2><p className="subtitle">从所选阶段开始处理，并自动继续后续阶段。</p>
    <div className="media-tabs">{choices.map(choice => <button key={choice.stage} className="btn" disabled={active || mutation.isPending} onClick={() => {
      if (window.confirm(choice.label + '会重新执行该阶段，' + choice.affected + '将转为历史版本；后续模型调用可能产生费用。确认继续？')) { setNotice(''); mutation.mutate(choice); }
    }}>{choice.label}</button>)}</div>
    {notice && <p className="notice" role="status">{notice}</p>}{mutation.error && <p className="error" role="alert">{mutation.error.message}</p>}
  </section>;
}
