import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { VideoPage } from '../../../packages/contracts/src/index';
interface Creator { id: string; uid: string; name: string; url: string; latestLimit: number; autoProcess: boolean; enabled: boolean; lastCheckedAt: string | null; latestError: string | null }
interface Operation { id: string; kind: string; status: string; attempt: number; createdAt: string; finishedAt: string | null; resultJson: string | null; errorMessage: string | null }
const statusName: Record<string, string> = { QUEUED: '排队中', RUNNING: '执行中', SUCCEEDED: '成功', FAILED: '失败', CANCELED: '已取消' };
function History({ operations }: { operations: Operation[] }) {
  return <div>{operations.length === 0 && <p className="subtitle">暂无执行记录</p>}{operations.map(item => {
    const result = item.resultJson ? JSON.parse(item.resultJson) : null;
    return <article className="run" key={item.id}><div><strong>{item.kind === 'BACKUP' ? '备份' : item.kind === 'CLEANUP' ? '清理检查' : '检查更新'} · {statusName[item.status]}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')} · 尝试 {item.attempt} 次</small></div>
      {item.errorMessage && <p className="error" role="alert">{item.errorMessage}</p>}
      {result && (item.kind === 'CREATOR_CHECK' ? <p>发现 {result.found} 条，新增 {result.added} 条；{result.autoProcess ? '新增视频已自动排队' : '新增视频等待手动处理'}。</p>
        : item.kind === 'BACKUP' ? <><p>已保存 {result.videos} 条视频记录、{result.files} 个媒体文件（{(result.bytes / 1024 ** 2).toFixed(1)} MiB）。</p><p className="mono">{result.storageKey}</p><small>{result.secrets}</small></>
        : <p>清理 {result.removed} 个临时/过期日志文件，释放 {(result.bytes / 1024 ** 2).toFixed(1)} MiB；发现 {result.orphans} 个未引用媒体文件（仅报告）、{result.missing} 个缺失或不可读取的引用。</p>)}
    </article>;
  })}</div>;
}
export function CreatorsPage() {
  const client = useQueryClient();
  const creators = useQuery({ queryKey: ['creators'], queryFn: () => api<Creator[]>('/creators'), refetchInterval: 5000 });
  const [editor, setEditor] = useState<Creator | 'add' | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = () => { void client.invalidateQueries({ queryKey: ['creators'] }); void client.invalidateQueries({ queryKey: ['creator-checks'] }); };
  const action = useMutation({ mutationFn: ({ id, name, body }: { id: string; name: 'check' | 'edit' | 'delete'; body?: unknown }) =>
    api('/creators/' + id + (name === 'check' ? '/actions/check' : ''), body || {}, name === 'edit' ? 'PATCH' : name === 'delete' ? 'DELETE' : 'POST'),
    onSuccess: (_result, input) => { setNotice(input.name === 'check' ? '检查任务已排队' : '追踪设置已更新'); refresh(); } });
  const all = useMutation({ mutationFn: async () => {
    let succeeded = 0; let failed = 0;
    for (const creator of creators.data || []) if (creator.enabled) {
      try { await api('/creators/' + creator.id + '/actions/check', {}); succeeded++; } catch { failed++; }
    }
    return { succeeded, failed };
  }, onSuccess: result => { setNotice(`${result.succeeded} 个检查任务已排队${result.failed ? `，${result.failed} 个提交失败，请重试` : ''}`); refresh(); } });
  return <>
    <header className="topbar"><h1>UP 主追踪</h1><div className="top-actions"><button className="btn" disabled={all.isPending || action.isPending || !creators.data?.some(item => item.enabled)} onClick={() => all.mutate()}>{all.isPending ? '正在提交…' : '↻ 全部检查'}</button><button className="btn primary" onClick={() => setEditor('add')}>＋ 添加 UP 主</button></div></header>
    {(creators.error || action.error) && <p className="error" role="alert">{(creators.error || action.error)?.message}</p>}
    {notice && <div className="creator-feedback" role="status">{notice}<button className="icon-btn" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    {creators.isPending && <div className="panel empty">正在读取追踪对象…</div>}
    {creators.data?.length === 0 && <div className="panel empty"><b>暂无追踪的 UP 主</b><div className="empty-action"><button className="btn primary" onClick={() => setEditor('add')}>＋ 添加 UP 主</button></div></div>}
    <div className="creator-list">{creators.data?.map(creator => <CreatorCard key={creator.id} creator={creator} pending={action.isPending || all.isPending}
      onAction={(name, body) => action.mutate({ id: creator.id, name, body })} onEdit={() => setEditor(creator)}/>)}</div>
    {editor && <CreatorEditor key={editor === 'add' ? 'add' : editor.id} creator={editor === 'add' ? null : editor} onClose={() => setEditor(null)} onSaved={id => {
      refresh(); setEditor(null); if (editor === 'add') action.mutate({ id, name: 'check' }); else setNotice('追踪设置已保存');
    }}/>}
  </>;
}
function CreatorEditor({ creator, onClose, onSaved }: { creator: Creator | null; onClose: () => void; onSaved: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const save = useMutation({ mutationFn: async (form: HTMLFormElement) => {
    const values = new FormData(form); const body = { latestLimit: Number(values.get('limit')), autoProcess: values.has('auto') };
    if (creator) { await api('/creators/' + creator.id, body, 'PATCH'); return { id: creator.id }; }
    return api<{ id: string }>('/creators', { ...body, source: values.get('source') });
  }, onSuccess: result => onSaved(result.id) });
  return <dialog ref={dialog} className="creator-modal" aria-labelledby="creator-modal-title" onCancel={event => { event.preventDefault(); if (!save.isPending) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !save.isPending) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }}>
    <form onSubmit={event => { event.preventDefault(); save.mutate(event.currentTarget); }}><div className="modal-head"><h2 id="creator-modal-title">{creator ? '追踪设置' : '添加 UP 主'}</h2><button type="button" className="icon-btn" aria-label="关闭弹窗" disabled={save.isPending} onClick={onClose}>×</button></div>
      <div className="modal-body">{!creator && <label className="setting-field">主页链接或 UID<input name="source" required autoFocus placeholder="https://space.bilibili.com/123456" disabled={save.isPending}/></label>}
      <label className="setting-field">每次获取最新视频数<input name="limit" type="number" min={1} max={50} defaultValue={creator?.latestLimit ?? 5} required disabled={save.isPending}/></label>
      <label className="checkbox"><input name="auto" type="checkbox" defaultChecked={creator?.autoProcess ?? true} disabled={save.isPending}/>发现新视频后自动处理</label>
      {save.error && <p className="error" role="alert">{save.error.message}</p>}</div><div className="modal-foot"><button type="button" className="btn" disabled={save.isPending} onClick={onClose}>取消</button><button className="btn primary" disabled={save.isPending}>{save.isPending ? '正在保存…' : creator ? '保存设置' : '添加并检查'}</button></div>
    </form></dialog>;
}
const videoState: Record<string, string> = { COMPLETED: '已完成', FAILED: '处理失败', CANCELED: '已取消', DISCOVERED: '待处理', WAITING: '等待处理', FETCHING: '获取中', EXTRACTING_AUDIO: '提取中', TRANSCRIBING: '转写中', SUMMARIZING: '总结中' };
function CreatorCard({ creator, pending, onAction, onEdit }: { creator: Creator; pending: boolean; onAction: (name: 'check' | 'edit' | 'delete', body?: unknown) => void; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const videos = useQuery({ queryKey: ['videos', 'creator-preview', creator.id], queryFn: () => api<VideoPage>('/videos?creatorId=' + creator.id + '&limit=3'), refetchInterval: 5000 });
  const checks = useQuery({ queryKey: ['creator-checks', creator.id], queryFn: () => api<Operation[]>('/creators/' + creator.id + '/checks'), refetchInterval: 3000 });
  const active = checks.data?.some(item => ['RUNNING', 'QUEUED'].includes(item.status));
  return <section className={'creator-group' + (open ? ' open' : '')}>
    <div className="creator-card"><a className="avatar" href={creator.url} target="_blank" rel="noreferrer" aria-label={'打开 ' + creator.name + ' 主页'}>{creator.name.slice(0, 1)}</a>
      <div className="creator-identity"><h3><a href={creator.url} target="_blank" rel="noreferrer">{creator.name}</a></h3><p>UID {creator.uid} · {creator.lastCheckedAt ? '上次检查 ' + new Date(creator.lastCheckedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未检查'} · {creator.enabled ? (creator.autoProcess ? '自动处理已开启' : '手动处理') : '已暂停'}</p></div>
      <div className="creator-stat"><b>{videos.data?.total ?? '—'}</b><span>已导入</span></div>
      <button className="btn small" disabled={pending || active || !creator.enabled} onClick={() => onAction('check')}>{active ? '检查中…' : '立即检查'}</button>
      <button className="btn small creator-toggle" aria-expanded={open} aria-controls={'creator-videos-' + creator.id} onClick={() => setOpen(!open)}>视频记录 <span className="chevron">⌄</span></button>
      <button className="icon-btn" aria-label={'设置 ' + creator.name} title="追踪设置" disabled={pending} onClick={onEdit}>⚙</button>
    </div>
    {creator.latestError && <p className="creator-inline-error">{creator.latestError}</p>}
    {(videos.error || checks.error) && <p className="error" role="alert">{(videos.error || checks.error)?.message}</p>}
    <div className="creator-reveal" inert={!open}><div><div className="creator-videos" id={'creator-videos-' + creator.id}>
      <div className="creator-videos-head"><span>已导入的视频 · 最近 {videos.data?.items.length ?? 0} 条</span><Link to={'/?creatorId=' + creator.id}>全部视频 ↗</Link></div>
      {videos.isPending ? <div className="creator-empty">正在读取视频…</div> : !videos.data?.items.length ? <div className="creator-empty">暂无视频记录</div> : videos.data.items.map(video => <div className="creator-video-row" key={video.id}>
        <div className="creator-video-main"><Link className="creator-video-title" to={'/videos/' + video.id}>{video.title}</Link><div className="creator-video-meta">{video.durationMs == null ? '时长未知' : Math.floor(video.durationMs / 60000) + ':' + String(Math.floor(video.durationMs / 1000) % 60).padStart(2, '0')}</div></div>
        <span className={'status ' + (video.overallStatus === 'COMPLETED' ? 'done' : video.overallStatus === 'FAILED' ? 'failed' : ['WAITING', 'DISCOVERED', 'CANCELED'].includes(video.overallStatus) ? 'waiting' : 'running')}>{videoState[video.overallStatus] || video.overallStatus}</span>
        <span className="date">{new Date(video.createdAt).toLocaleDateString('zh-CN')}</span><Link className="icon-btn" aria-label={'查看详情：' + video.title} to={'/videos/' + video.id}>↗</Link></div>)}
      <div className="creator-secondary"><button className="btn small" aria-expanded={history} onClick={() => setHistory(!history)}>检查记录 {history ? '⌃' : '⌄'}</button><button className="btn small" disabled={pending} onClick={() => onAction('edit', { enabled: !creator.enabled })}>{creator.enabled ? '暂停追踪' : '启用追踪'}</button><button className="btn small danger" disabled={pending} onClick={() => { if (window.confirm('停止追踪该 UP 主？已导入视频和检查记录会保留。')) onAction('delete'); }}>停止追踪</button></div>
      {history && <History operations={checks.data || []}/>}
    </div></div></div>
  </section>;
}
export function MaintenancePage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['maintenance'], queryFn: () => api<{ backupDirectory: string; logDirectory: string; operations: Operation[] }>('/maintenance'), refetchInterval: 3000 });
  const [notice, setNotice] = useState('');
  const mutation = useMutation({ mutationFn: (action: string) => api('/maintenance/actions/' + action, {}),
    onSuccess: () => { setNotice('维护任务已排队，完成后会显示结果。'); void client.invalidateQueries({ queryKey: ['maintenance'] }); } });
  const active = (kind: string) => query.data?.operations.some(op => op.kind === kind && ['RUNNING', 'QUEUED'].includes(op.status));
  return <>
    <header className="topbar"><div><div className="eyebrow">WORKSPACE / MAINTENANCE</div><h1>备份与维护</h1></div></header>
    <div className="settings-grid"><section className="panel"><h2>完整备份</h2>
      <p className="result-meta">备份位置：{query.data?.backupDirectory || '正在读取…'}</p><p className="subtitle">包含配置和密钥引用；.env 原文、密钥及 Cookie 文件需另行保管。恢复需停止服务，按 README 的恢复步骤操作。</p>
      <button className="btn primary" disabled={mutation.isPending || active('BACKUP')} onClick={() => mutation.mutate('backup')}>{active('BACKUP') ? '备份任务进行中…' : '创建备份'}</button></section>
      <section className="panel"><h2>临时文件与日志</h2>
        <p className="subtitle">原视频、音频和备份不会被清理；未引用的永久媒体仅报告数量。日志按日期或 5 MiB 轮转。</p><p className="result-meta">日志目录：{query.data?.logDirectory || '正在读取…'}</p>
        <button className="btn" disabled={mutation.isPending || active('CLEANUP')} onClick={() => mutation.mutate('cleanup')}>{active('CLEANUP') ? '清理检查进行中…' : '立即清理检查'}</button></section></div>
    {(query.error || mutation.error) && <p className="error" role="alert">{(query.error || mutation.error)?.message}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <section className="panel prompt-panel"><h2>维护记录</h2><History operations={query.data?.operations || []}/></section>
  </>;
}
