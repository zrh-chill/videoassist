import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import type { VideoDto, VideoPage, VideoDetail, RunDto } from '../../../packages/contracts/src/index';
import { stages, statuses } from '../../../packages/contracts/src/index';
import { api, useEvents } from './api';
import './styles.css';
import './fidelity.css';
import { MediaResults, ReprocessActions, sourceName } from './media';
import { SettingsPage } from './settings';
import { CreatorsPage, MaintenancePage } from './operations';
import { VideoImport } from './video-import';
import { VideoTable, VideoCover, VideoByline } from './video-table';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchInterval: 10_000, refetchIntervalInBackground: true } } });
const names: Record<string, string> = {
  DISCOVERED: '已发现，待处理',
  WAITING: '等待处理', FETCHING: '获取视频中', EXTRACTING_AUDIO: '提取音频中', TRANSCRIBING: '转写中',
  SUMMARIZING: '总结中', COMPLETED: '已完成', FAILED: '处理失败', CANCELED: '已取消',
  FETCH: '获取视频', EXTRACT_AUDIO: '提取音频', TRANSCRIBE: '全文转写', SUMMARIZE: 'AI 总结',
  QUEUED: '排队中', RUNNING: '处理中', SUCCEEDED: '成功', INTERRUPTED: '执行中断',
};
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
function Status({ status }: { status: string }) {
  return <span className={'status ' + (status === 'FAILED' ? 'failed' : ['COMPLETED', 'SUCCEEDED'].includes(status) ? 'done' : ['DISCOVERED', 'WAITING', 'CANCELED', 'INTERRUPTED', 'QUEUED'].includes(status) ? 'waiting' : 'running')}>{names[status] || status}</span>;
}
function ErrorNotice({ error }: { error: Error | null }) {
  return error ? <p className="error" role="alert">{error.message}</p> : null;
}
function PageRoutes() {
  const location = useLocation();
  const [shownLocation, setShownLocation] = useState(location);
  const leaving = location.pathname !== shownLocation.pathname;
  useEffect(() => {
    if (!leaving) return;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140;
    const timer = window.setTimeout(() => setShownLocation(location), duration);
    return () => window.clearTimeout(timer);
  }, [location, leaving]);
  // Keep the outgoing route mounted during its fade; filters and SSE never restart it.
  return <div key={shownLocation.pathname} className={'page-transition ' + (leaving ? 'page-leaving' : 'page-entering')} inert={leaving}>
    <Routes location={leaving ? shownLocation : location}><Route path="/" element={<VideoList/>}/><Route path="/add" element={<Navigate to="/" replace/>}/><Route path="/videos/:id" element={<Detail/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/creators" element={<CreatorsPage/>}/><Route path="/maintenance" element={<MaintenancePage/>}/><Route path="*" element={<p>页面不存在，<Link to="/">返回任务列表</Link></p>}/></Routes>
  </div>;
}
function Layout() {
  const connected = useEvents();
  const location = useLocation();
  const count = useQuery({ queryKey: ['videos', 'count', ''], queryFn: () => api<VideoPage>('/videos?limit=1') });
  return <div className="app">
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="brand-mark">帧</span><span><strong>帧语</strong><small>FRAMENOTE</small></span></Link>
      <nav aria-label="主导航">
        <div className="nav-label">WORKSPACE</div>
        <Link to="/" aria-current={location.pathname === '/' || location.pathname.startsWith('/videos/') ? 'page' : undefined} className={'nav-item' + (location.pathname === '/' || location.pathname.startsWith('/videos/') ? ' active' : '')}><span className="nav-icon">▦</span>视频任务<span className="nav-badge">{count.data?.total ?? '—'}</span></Link>
        <Link to="/creators" aria-current={location.pathname === '/creators' ? 'page' : undefined} className={'nav-item' + (location.pathname === '/creators' ? ' active' : '')}><span className="nav-icon">◎</span>UP 主追踪</Link>
        <div className="nav-label system-label">SYSTEM</div>
        <Link to="/settings" aria-current={location.pathname === '/settings' ? 'page' : undefined} className={'nav-item' + (location.pathname === '/settings' ? ' active' : '')}><span className="nav-icon">⚙</span>系统设置</Link>
        <Link to="/maintenance" aria-current={location.pathname === '/maintenance' ? 'page' : undefined} className={'nav-item' + (location.pathname === '/maintenance' ? ' active' : '')}><span className="nav-icon">▣</span>备份与维护</Link>
      </nav>
      <div className="sidebar-foot"><span className={'dot ' + (connected ? 'live' : '')}/>{connected ? '实时更新已连接' : '每 10 秒同步状态'}</div>
    </aside>
    <main className="main"><PageRoutes/></main>
  </div>;
}
function VideoList() {
  const [search, setSearch] = useSearchParams();
  const [exportHistory, setExportHistory] = useState(false);
  const exportQuery = new URLSearchParams(search); exportQuery.delete('cursor'); exportQuery.delete('limit'); exportQuery.set('history', String(exportHistory));
  const query = useQuery({ queryKey: ['videos', search.toString()], queryFn: () => api<VideoPage>('/videos?' + search.toString()) });
  const counts = useQueries({ queries: ['', 'FETCHING', 'EXTRACTING_AUDIO', 'TRANSCRIBING', 'SUMMARIZING', 'COMPLETED', 'FAILED'].map(status => ({
    queryKey: ['videos', 'count', status], queryFn: () => api<VideoPage>('/videos?limit=1' + (status ? '&status=' + status : '')),
  })) });
  const number = (index: number) => counts[index]?.data?.total;
  const running = counts.slice(1, 5).every(item => item.data) ? counts.slice(1, 5).reduce((sum, item) => sum + item.data!.total, 0) : undefined;
  const stats = [
    { label: '全部视频', value: number(0), meta: '所有已导入的视频任务' },
    { label: '处理中', value: running, meta: '获取 · 提取 · 转写 · 总结' },
    { label: '已完成', value: number(5), meta: '文稿与总结已保存' },
    { label: '处理失败', value: number(6), meta: '需要你的关注', danger: true },
  ];
  const filter = (key: string, value: string) => {
    setSearch(previous => { const next = new URLSearchParams(previous); next.delete('cursor'); value ? next.set(key, value) : next.delete(key); return next; });
  };
  return <>
    <header className="topbar video-list-heading"><h1>视频任务</h1></header>
    <VideoImport onAdded={() => setSearch({})}><div className="export-control"><a className="btn" href={'/api/v1/exports/videos.xlsx?' + exportQuery.toString()} download>⇩ 导出 Excel</a><details className="export-options"><summary aria-label="导出选项">⌄</summary><div className="export-popover"><strong>导出当前筛选结果</strong><label className="checkbox"><input type="checkbox" checked={exportHistory} onChange={event => setExportHistory(event.target.checked)}/>包含处理记录</label><p>超长单元格会标记截断，全文可在详情查看。</p></div></details></div></VideoImport>
    <div className="stats">{stats.map(stat => <div className="stat" key={stat.label}><div className="stat-label">{stat.label}</div><div className={'stat-value' + (stat.danger ? ' stat-danger' : '')}>{stat.value === undefined ? '—' : String(stat.value).padStart(2, '0')}</div></div>)}</div>
    <ErrorNotice error={counts.find(item => item.error)?.error ?? null}/>
    <div className="toolbar"><label className="search-label"><span aria-hidden="true">⌕</span><input aria-label="搜索视频标题" placeholder="搜索视频标题…" value={search.get('q') || ''} onChange={event => filter('q', event.target.value)}/></label>
      <select aria-label="视频来源" value={search.get('sourceType') || ''} onChange={event => filter('sourceType', event.target.value)}><option value="">全部来源</option>{Object.entries(sourceName).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="处理状态" value={search.get('status') || ''} onChange={event => filter('status', event.target.value)}><option value="">全部状态</option>{statuses.map(status => <option key={status} value={status}>{names[status]}</option>)}</select>
      <button className="btn small" onClick={() => setSearch({})}>重置</button></div>
    <ErrorNotice error={query.error}/>
    {search.has('creatorId') && <p className="notice">正在显示所选 UP 主已导入的视频。<Link to="/creators">返回 UP 主追踪 →</Link></p>}
    <VideoTable items={query.data?.items || []} loading={query.isPending} empty={<><b>还没有匹配的任务</b><button className="btn primary" onClick={() => document.getElementById('video-url')?.focus()}>＋ 添加视频</button></>}/>
    <div className="pagination"><span>显示 {query.data?.items.length ?? 0} 条，共 {query.data?.total ?? 0} 条</span><div className="top-actions">{search.has('cursor') && <button className="btn small" onClick={() => filter('cursor', '')}>← 返回首页</button>}<button className="btn small" disabled={!query.data?.nextCursor} onClick={() => setSearch(previous => { const next = new URLSearchParams(previous); next.set('cursor', query.data!.nextCursor!); return next; })}>下一页 →</button></div></div>
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
  const terminal = ['DISCOVERED', 'COMPLETED', 'FAILED', 'CANCELED'].includes(video.overallStatus);
  return <>
    <Link className="detail-back" to="/">← 返回视频任务</Link>
    <header className="detail-hero"><VideoCover video={video}/><div className="detail-heading"><h1>{video.title}</h1><VideoByline video={video}/>{video.originalUrl && <a className="detail-source" href={video.originalUrl} target="_blank" rel="noreferrer">打开原视频 ↗</a>}</div><Status status={video.overallStatus}/></header>
    {video.sourceType === 'SIMULATION' && <div className="notice"><strong>模拟处理结果</strong><span>此记录由模拟处理器生成，未调用真实模型。</span></div>}
    <ErrorNotice error={action.error}/><ErrorNotice error={runs.error}/>
    {video.latestErrorMessage && <p className="error" role="alert">{video.latestErrorMessage} <span className="mono">{video.latestErrorCode}</span></p>}
    <div className="actions">
      {video.overallStatus === 'DISCOVERED' && <button className="btn primary" disabled={action.isPending} onClick={() => action.mutate('start')}>开始处理视频</button>}
      {!terminal && <button className="btn danger" disabled={action.isPending || cancelRequested} onClick={() => action.mutate('cancel')}>{cancelRequested ? '正在取消…' : '取消任务'}</button>}
      {['FAILED', 'CANCELED'].includes(video.overallStatus) && <button className="btn primary" disabled={action.isPending} onClick={() => setConfirming(!confirming)}>从当前阶段重试</button>}
    </div>
    {confirming && <div className="panel"><p>将重新执行「{names[video.currentStage || '']}」阶段，之前成功阶段的结果会被保留并复用。</p><button className="btn primary" disabled={action.isPending} onClick={() => action.mutate('retry')}>确认重试</button></div>}
    {video.sourceType !== 'SIMULATION' && <MediaResults id={video.id} active={!terminal}/>}
    {video.sourceType !== 'SIMULATION' && video.overallStatus !== 'DISCOVERED' && <ReprocessActions id={video.id} sourceType={video.sourceType} active={!terminal}/>}
    <section className="panel"><h2>执行记录 <span className="count">{runs.data?.length ?? 0}</span></h2>
      {!runs.data?.length && <p className="subtitle">{video.overallStatus === 'CANCELED' ? '任务已取消，尚未执行任何阶段。' : '任务已持久化，等待 Worker 领取。'}</p>}
      {runs.data?.map(run => <article className="run" key={run.id}><div><strong>{names[run.stage]} · 第 {run.attempt} 次</strong><Status status={run.status}/></div><p className="mono">{time(run.startedAt)}{run.finishedAt ? ' · 耗时 ' + Math.max(0, (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1) + ' 秒' : ' · 正在执行'}</p>
        {run.errorMessage && <p className="error">{run.errorMessage}</p>}{run.outputJson && <p>{(JSON.parse(run.outputJson) as { text: string }).text}</p>}</article>)}
    </section>
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><BrowserRouter><Layout/></BrowserRouter></QueryClientProvider></React.StrictMode>);
