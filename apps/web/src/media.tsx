import React, { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from './select';
import { api } from './api';
import type { TranscriptDto, SummaryDto, StructuredSummary } from '../../../packages/contracts/src/media';

export const sourceName: Record<string, string> = { LOCAL: '本地视频', BILIBILI: 'B 站', SIMULATION: '模拟任务' };
interface Version { id: string; revision: number; isCurrent: boolean }
interface Versioned<T> { current: T | null; versions: Version[] }
function VersionSelect({ label, value, versions, onChange }: { label: string; value: string; versions: Version[]; onChange: (value: string) => void }) {
  return <Select label={label} value={value} onChange={onChange} options={[{ value: '', label: '当前版本' }, ...versions.map(version => ({ value: String(version.revision), label: '版本 ' + version.revision + (version.isCurrent ? ' · 当前' : '') }))]}/>;
}
function SummaryMarkdown({ children }: { children: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{children}</Markdown>;
}
function SummaryContent({ data }: { data: StructuredSummary }) {
  return <div className="summary-content markdown-body"><div className="summary-lead"><SummaryMarkdown>{data.one_sentence}</SummaryMarkdown></div><h3>核心要点</h3><ul>{data.key_points.map((point, index) => <li key={index}><SummaryMarkdown>{point}</SummaryMarkdown></li>)}</ul>
    <SummaryMarkdown>{data.detailed_summary}</SummaryMarkdown><div className="keywords">{data.keywords.map(word => <span key={word}>{word}</span>)}</div></div>;
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
  return <section className="panel"><h2>重新处理</h2>
    <div className="media-tabs">{choices.map(choice => <button key={choice.stage} className="btn" disabled={active || mutation.isPending} onClick={() => {
      if (window.confirm(choice.label + '会重新执行该阶段，' + choice.affected + '将转为历史版本；后续模型调用可能产生费用。确认继续？')) { setNotice(''); mutation.mutate(choice); }
    }}>{choice.label}</button>)}</div>
    {notice && <p className="notice" role="status">{notice}</p>}{mutation.error && <p className="error" role="alert">{mutation.error.message}</p>}
  </section>;
}
