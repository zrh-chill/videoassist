import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VideoDto, VideoPage, VideoDetail, RunDto } from '../../../packages/contracts/src/index';
import { stages, statuses } from '../../../packages/contracts/src/index';
import { api, useEvents } from './api';
import './styles.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchInterval: 10_000, refetchIntervalInBackground: true } } });
const names: Record<string, string> = {
  WAITING: '等待处理', FETCHING: '获取视频中', EXTRACTING_AUDIO: '提取音频中', TRANSCRIBING: '转写中',
  SUMMARIZING: '总结中', COMPLETED: '已完成', FAILED: '处理失败', CANCELED: '已取消',
  FETCH: '获取视频', EXTRACT_AUDIO: '提取音频', TRANSCRIBE: '全文转写', SUMMARIZE: 'AI 总结',
  QUEUED: '排队中', RUNNING: '处理中', SUCCEEDED: '成功', INTERRUPTED: '执行中断',
};
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
function Status({ status }: { status: string }) {
  return <span className={'status ' + (status === 'FAILED' ? 'failed' : ['COMPLETED', 'SUCCEEDED'].includes(status) ? 'done' : ['WAITING', 'CANCELED', 'INTERRUPTED', 'QUEUED'].includes(status) ? 'waiting' : 'running')}>{names[status] || status}</span>;
}
function ErrorNotice({ error }: { error: Error | null }) {
  return error ? <p className="error" role="alert">{error.message}</p> : null;
}
function Layout() {
  const connected = useEvents();
  return <div className="app">
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="brand-mark">帧</span><span><strong>帧语</strong><small>FRAMENOTE / WORKSPACE</small></span></Link>
      <span className="nav-label">工作空间</span>
      <Link to="/" className="nav-item active"><span>▤</span> 视频任务</Link>
      <div className="sidebar-foot"><span className={'dot ' + (connected ? 'live' : '')}/>{connected ? '实时更新已连接' : '每 10 秒同步状态'}<p>第一阶段 · 持久任务验证</p></div>
    </aside>
    <main className="main"><Routes><Route path="/" element={<VideoList/>}/><Route path="/videos/:id" element={<Detail/>}/><Route path="*" element={<p>页面不存在，<Link to="/">返回任务列表</Link></p>}/></Routes></main>
  </div>;
}
function VideoList() {
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const query = useQuery({ queryKey: ['videos', search.toString()], queryFn: () => api<VideoPage>('/videos?' + search.toString()) });
  const capability = useQuery({ queryKey: ['capabilities'], queryFn: () => api<{ simulation: boolean }>('/capabilities'), refetchInterval: false });
  const filter = (key: string, value: string) => {
    setSearch(previous => { const next = new URLSearchParams(previous); next.delete('cursor'); value ? next.set(key, value) : next.delete(key); return next; });
  };
  return <>
    <header className="topbar"><div><div className="eyebrow">YOUR VIDEO KNOWLEDGE, ORGANIZED</div><h1>视频任务<span className="count">{query.data?.total ?? '—'}</span></h1><p className="subtitle">从视频到文字，让每一帧都有价值。</p></div>
      <button className="btn primary" disabled={!capability.data?.simulation} onClick={() => setAdding(!adding)}>{adding ? '收起表单' : '＋ 添加模拟任务'}</button></header>
    <div className="notice"><strong>工程验证模式</strong><span>验证排队、阶段流转、故障恢复和取消。当前不上传媒体、不调用模型。</span></div>
    <ErrorNotice error={capability.error}/>
    {capability.data && !capability.data.simulation && <p className="error">模拟模式未开启，请在启动前设置 ENABLE_SIMULATION=true。</p>}
    {adding && <CreateForm onDone={id => navigate('/videos/' + id)}/>}
    <div className="toolbar"><label className="search-label"><span>搜索标题</span><input placeholder="搜索视频标题…" value={search.get('q') || ''} onChange={event => filter('q', event.target.value)}/></label>
      <label><span className="sr-only">处理状态</span><select value={search.get('status') || ''} onChange={event => filter('status', event.target.value)}><option value="">全部状态</option>{statuses.map(status => <option key={status} value={status}>{names[status]}</option>)}</select></label>
      <button className="btn" onClick={() => setSearch({})}>重置筛选</button></div>
    <ErrorNotice error={query.error}/>
    <div className="table-wrap"><table><thead><tr><th>视频</th><th>来源</th><th>当前状态</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>{query.data?.items.map(video => <tr key={video.id}>
        <td><Link className="video-link" to={'/videos/' + video.id}><span className="thumb">▷</span><span><strong>{video.title}</strong><small>{names[video.currentStage || ''] || '等待处理'}{video.latestErrorMessage ? ' · ' + video.latestErrorMessage : ''}</small></span></Link></td>
        <td><span className="source">模拟任务</span></td><td><Status status={video.overallStatus}/></td><td className="mono">{time(video.createdAt)}</td><td><Link className="btn small" to={'/videos/' + video.id}>查看详情 ↗</Link></td>
      </tr>)}</tbody></table>
      {query.isPending && <div className="empty">正在读取任务…</div>}
      {query.data?.items.length === 0 && <div className="empty"><b>还没有匹配的任务</b><p>添加一个模拟任务，观察完整处理流程。</p></div>}
    </div>
    <div className="pagination"><span>共 {query.data?.total ?? 0} 条任务 · 筛选条件保存在地址栏</span>{query.data?.nextCursor && <button className="btn" onClick={() => setSearch(previous => { const next = new URLSearchParams(previous); next.set('cursor', query.data!.nextCursor!); return next; })}>下一页 →</button>}{search.has('cursor') && <button className="btn" onClick={() => filter('cursor', '')}>返回首页</button>}</div>
  </>;
}
function CreateForm({ onDone }: { onDone: (id: string) => void }) {
  const mutation = useMutation({ mutationFn: (body: unknown) => api<{ id: string }>('/videos/simulations', body), onSuccess: data => onDone(data.id) });
  return <form className="panel create-form" onSubmit={event => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    mutation.mutate({ title: values.get('title'), ...(values.get('failStage') ? { failStage: values.get('failStage') } : {}), retryableFailure: values.get('retryable') === 'on' });
  }}>
    <h2>创建模拟任务</h2><label>任务标题<input name="title" required maxLength={200} placeholder="例如：验证单条任务处理流程"/></label>
    <label>故障模拟<select name="failStage"><option value="">不注入故障</option>{stages.map(stage => <option key={stage} value={stage}>{names[stage]}首次失败</option>)}</select></label>
    <label className="checkbox"><input type="checkbox" name="retryable"/>自动退避重试（首次等待 1 分钟）</label>
    <ErrorNotice error={mutation.error}/><button className="btn primary" disabled={mutation.isPending}>{mutation.isPending ? '正在创建…' : '创建任务'}</button>
  </form>;
}
function Detail() {
  const { id } = useParams<{ id: string }>();
  const cache = useQueryClient();
  const detail = useQuery({ queryKey: ['video', id], queryFn: () => api<VideoDetail>('/videos/' + id) });
  const runs = useQuery({ queryKey: ['video', id, 'runs'], queryFn: () => api<RunDto[]>('/videos/' + id + '/runs') });
  const [confirming, setConfirming] = useState(false);
  const action = useMutation({ mutationFn: (name: string) => api('/videos/' + id + '/actions/' + name, {}),
    onSuccess: () => { setConfirming(false); void cache.invalidateQueries({ queryKey: ['video', id] }); void cache.invalidateQueries({ queryKey: ['videos'] }); } });
  const video = detail.data;
  if (!video) return <><Link to="/">← 返回视频任务</Link><ErrorNotice error={detail.error}/>{detail.isPending && <p>正在加载详情…</p>}</>;
  const cancelRequested = video.jobs.some(job => job.status === 'RUNNING' && job.cancelRequestedAt);
  const terminal = ['COMPLETED', 'FAILED', 'CANCELED'].includes(video.overallStatus);
  return <>
    <Link className="detail-back" to="/">← 返回视频任务</Link>
    <header className="detail-hero"><div className="hero-thumb">▷</div><div><div className="eyebrow">SIMULATION / PERSISTENT TASK</div><h1>{video.title}</h1><p className="subtitle">模拟任务 · 创建于 {time(video.createdAt)}</p></div><Status status={video.overallStatus}/></header>
    <div className="notice"><strong>模拟处理结果</strong><span>此页面展示真实保存的任务状态与执行记录，内容为模拟处理器输出。</span></div>
    <div className="stage-grid">{stages.map(stage => {
      const job = video.jobs.find(item => item.stage === stage);
      return <div className="panel stage-card" key={stage}><span className="eyebrow">0{stages.indexOf(stage) + 1}</span><h3>{names[stage]}</h3><Status status={job?.status || 'WAITING'}/><p>{job ? '已尝试 ' + job.attempt + ' 次' : '等待上游完成'}</p></div>;
    })}</div>
    <ErrorNotice error={action.error}/><ErrorNotice error={runs.error}/>
    {video.latestErrorMessage && <p className="error" role="alert">{video.latestErrorMessage} <span className="mono">{video.latestErrorCode}</span></p>}
    <div className="actions">
      {!terminal && <button className="btn danger" disabled={action.isPending || cancelRequested} onClick={() => action.mutate('cancel')}>{cancelRequested ? '正在取消…' : '取消任务'}</button>}
      {['FAILED', 'CANCELED'].includes(video.overallStatus) && <button className="btn primary" disabled={action.isPending} onClick={() => setConfirming(!confirming)}>从当前阶段重试</button>}
    </div>
    {confirming && <div className="panel"><p>将重新执行「{names[video.currentStage || '']}」阶段，之前成功阶段的结果会被保留并复用。</p><button className="btn primary" disabled={action.isPending} onClick={() => action.mutate('retry')}>确认重试</button></div>}
    <section className="panel"><h2>执行记录 <span className="count">{runs.data?.length ?? 0}</span></h2>
      {!runs.data?.length && <p className="subtitle">任务已持久化，等待 Worker 领取。</p>}
      {runs.data?.map(run => <article className="run" key={run.id}><div><strong>{names[run.stage]} · 第 {run.attempt} 次</strong><Status status={run.status}/></div><p className="mono">{time(run.startedAt)}{run.finishedAt ? ' · 耗时 ' + Math.max(0, (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1) + ' 秒' : ' · 正在执行'}</p>
        {run.errorMessage && <p className="error">{run.errorMessage}</p>}{run.outputJson && <p>{(JSON.parse(run.outputJson) as { text: string }).text}</p>}</article>)}
    </section>
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><BrowserRouter><Layout/></BrowserRouter></QueryClientProvider></React.StrictMode>);
