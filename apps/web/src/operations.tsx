import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
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
  const [selected, setSelected] = useState('');
  const checks = useQuery({ queryKey: ['creator-checks', selected], queryFn: () => api<Operation[]>('/creators/' + selected + '/checks'), enabled: Boolean(selected), refetchInterval: 3000 });
  const [notice, setNotice] = useState('');
  const add = useMutation({ mutationFn: (form: HTMLFormElement) => {
    const values = new FormData(form);
    return api<{ id: string }>('/creators', { source: values.get('source'), latestLimit: Number(values.get('limit')), autoProcess: values.has('auto') });
  }, onSuccess: result => { setSelected(result.id); setNotice('追踪对象已保存，点击立即检查获取最新视频。'); void client.invalidateQueries({ queryKey: ['creators'] }); } });
  const action = useMutation({ mutationFn: ({ id, name, body }: { id: string; name: 'check' | 'edit' | 'delete'; body?: unknown }) =>
    api('/creators/' + id + (name === 'check' ? '/actions/check' : ''), body || {}, name === 'edit' ? 'PATCH' : name === 'delete' ? 'DELETE' : 'POST'),
    onSuccess: (_result, input) => { setSelected(input.id); setNotice(input.name === 'check' ? '检查任务已排队，结果将在下方更新。' : '追踪设置已更新，既有视频保留。'); void client.invalidateQueries({ queryKey: ['creators'] }); void client.invalidateQueries({ queryKey: ['creator-checks'] }); } });
  return <>
    <header className="topbar"><div><div className="eyebrow">CREATORS / FOLLOWING</div><h1>UP 主追踪</h1></div></header>
    <form className="panel creator-add" onSubmit={event => { event.preventDefault(); add.mutate(event.currentTarget); }}>
      <label className="setting-field">UID 或主页链接<input name="source" required placeholder="https://space.bilibili.com/…" disabled={add.isPending}/></label>
      <label className="setting-field">最新视频数量<input name="limit" type="number" min={1} max={50} defaultValue={5} required disabled={add.isPending}/></label>
      <label className="checkbox"><input name="auto" type="checkbox" defaultChecked disabled={add.isPending}/>自动处理新增视频</label>
      <button className="btn primary" disabled={add.isPending}>{add.isPending ? '正在添加…' : '添加追踪'}</button>
    </form>
    
    {(creators.error || add.error || action.error || checks.error) && <p className="error" role="alert">{(creators.error || add.error || action.error || checks.error)?.message}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!creators.data?.length && <div className="panel empty">还没有追踪对象，先添加一个 UP 主。</div>}
    <div className="settings-grid">{creators.data?.map(creator => <CreatorCard key={creator.id + creator.latestLimit + creator.autoProcess + creator.enabled} creator={creator} pending={action.isPending}
      onAction={(name, body) => action.mutate({ id: creator.id, name, body })} onHistory={() => setSelected(creator.id)}/>)}</div>
    {selected && <section className="panel prompt-panel"><h2>最近检查记录</h2><History operations={checks.data || []}/></section>}
  </>;
}
function CreatorCard({ creator, pending, onAction, onHistory }: { creator: Creator; pending: boolean; onAction: (name: 'check' | 'edit' | 'delete', body?: unknown) => void; onHistory: () => void }) {
  const [limit, setLimit] = useState(creator.latestLimit); const [auto, setAuto] = useState(creator.autoProcess);
  return <section className="panel"><h2>{creator.name}</h2><p className="subtitle">UID {creator.uid} · {creator.enabled ? '已启用' : '已暂停'}</p><a href={creator.url} target="_blank" rel="noreferrer">打开主页 ↗</a>
    <label className="setting-field">检查数量<input type="number" min={1} max={50} value={limit} disabled={pending} onChange={event => setLimit(Number(event.target.value))}/></label>
    <label className="checkbox"><input type="checkbox" checked={auto} disabled={pending} onChange={event => setAuto(event.target.checked)}/>自动处理</label>
    <div className="actions"><button className="btn primary" disabled={pending || !creator.enabled} onClick={() => onAction('check')}>立即检查</button>
      <button className="btn" disabled={pending || !Number.isInteger(limit) || limit < 1 || limit > 50} onClick={() => onAction('edit', { latestLimit: limit, autoProcess: auto })}>保存选项</button>
      <button className="btn" disabled={pending} onClick={() => onAction('edit', { enabled: !creator.enabled })}>{creator.enabled ? '暂停追踪' : '启用追踪'}</button>
      <button className="btn danger" disabled={pending} onClick={() => { if (window.confirm('停止追踪该 UP 主？已导入视频和检查记录会保留。')) onAction('delete'); }}>停止追踪</button></div>
    <div className="media-tabs"><button className="btn" onClick={onHistory}>查看检查记录</button><Link className="btn" to={'/?creatorId=' + creator.id}>查看已导入视频</Link></div>
    <p className="result-meta">{creator.lastCheckedAt ? '上次检查：' + new Date(creator.lastCheckedAt).toLocaleString('zh-CN') : '尚未检查'}</p>
    {creator.latestError && <p className="error">{creator.latestError}</p>}
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
