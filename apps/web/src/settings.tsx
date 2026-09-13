import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select } from './select';
import { ConfirmDialog } from './dialog';
import { api } from './api';
import type { SettingsDto, SettingsValues, SettingKey, TestKind, ConnectionResult, PromptDto } from '../../../packages/contracts/src/settings';

const labels: Record<SettingKey, string> = {
  FFMPEG_PATH: 'FFmpeg 路径', FFPROBE_PATH: 'FFprobe 路径', YTDLP_PATH: 'yt-dlp 路径',
  S2T_BASE_URL: '转写接口地址', S2T_MODEL: '转写模型', S2T_API_KEY_REF: '转写密钥引用',
  LLM_BASE_URL: '总结接口地址', LLM_MODEL: '总结模型', LLM_API_KEY_REF: '总结密钥引用',
  BILIBILI_COOKIE_FILE_REF: 'Cookie 文件引用',
  UPLOAD_MAX_BYTES: '上传上限（字节）', DOWNLOAD_MAX_BYTES: '下载上限（字节）',
  AUDIO_CHUNK_MINUTES: '音频分片（分钟）', S2T_MAX_BYTES: '转写单片上限（字节）',
  SUMMARY_MAX_INPUT_TOKENS: '总结输入令牌预算', MODEL_TIMEOUT_MS: '模型超时（毫秒）', LLM_MAX_OUTPUT_TOKENS: '总结输出令牌上限',
};
const groups: Array<{ title: string; keys: SettingKey[]; tests?: TestKind[] }> = [
  { title: '媒体工具', keys: ['FFMPEG_PATH', 'FFPROBE_PATH', 'YTDLP_PATH'], tests: ['ffmpeg', 'ytdlp'] },
  { title: '语音转写 S2T', keys: ['S2T_BASE_URL', 'S2T_MODEL', 'S2T_API_KEY_REF', 'AUDIO_CHUNK_MINUTES', 'S2T_MAX_BYTES'], tests: ['s2t'] },
  { title: 'AI 总结 LLM', keys: ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY_REF', 'SUMMARY_MAX_INPUT_TOKENS', 'LLM_MAX_OUTPUT_TOKENS', 'MODEL_TIMEOUT_MS'], tests: ['llm'] },
  { title: 'B 站', keys: ['BILIBILI_COOKIE_FILE_REF'] },
  { title: '存储与容量', keys: ['UPLOAD_MAX_BYTES', 'DOWNLOAD_MAX_BYTES'] },
];
export function SettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsDto>('/settings'), refetchInterval: false, refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const save = useMutation({ mutationFn: () => {
    const values: SettingsValues = {};
    for (const field of query.data!.fields) if (field.key in draft) {
      const value = draft[field.key]!;
      if (field.secret && !value && field.key !== 'BILIBILI_COOKIE_FILE_REF') continue;
      Object.assign(values, { [field.key]: typeof field.value === 'number' ? Number(value) : value });
    }
    return api('/settings', { revision: query.data!.revision, values }, 'PUT');
  }, onSuccess: () => { setDraft({}); setNotice('设置已保存，将用于下一次阶段执行和连接测试。'); void client.invalidateQueries({ queryKey: ['settings'] }); void client.invalidateQueries({ queryKey: ['capabilities'] }); } });
  const test = useMutation({ mutationFn: (kind: TestKind) => api<ConnectionResult>('/settings/actions/test-' + kind, {}),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['settings'] }); } });
  if (!query.data) return <div className="panel">{query.error ? query.error.message : '正在读取设置…'}</div>;
  const data = query.data;
  const dirty = Object.keys(draft).length > 0;
  const busy = save.isPending || test.isPending;
  return <>
    <header className="topbar"><div><div className="eyebrow">WORKSPACE / SETTINGS</div><h1>系统设置</h1></div></header>
    <div className="notice"><strong>配置优先级</strong><span>环境变量优先于页面设置；标有“环境变量”的项目需在服务端修改。密钥仅填写 env:变量名 或 file:文件路径。</span></div>
    <form onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="settings-grid">{groups.map(group => <section className="panel" key={group.title}><h2>{group.title}</h2>
        {group.title === '存储与容量' && <p className="result-meta">数据目录：{data.storage.dataDir}<br/>监听：{data.storage.host}:{data.storage.port}（修改需重启服务）</p>}
        {group.keys.map(key => {
          const field = data.fields.find(item => item.key === key)!;
          return <label className="setting-field" key={key}><span>{labels[key]} <small>{field.source === 'environment' ? '环境变量' : field.source === 'database' ? '已保存' : '默认值'}</small></span>
            <input type={typeof field.value === 'number' ? 'number' : 'text'} step="any" disabled={field.source === 'environment' || busy}
              value={draft[key] ?? (field.secret ? '' : String(field.value ?? ''))} autoComplete="off"
              placeholder={field.secret ? '留空保留现有引用' : ''} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))}/>
            {field.secret && <small>{field.configured ? '已配置' : '未配置或不可读取'} · {field.referenceType} 引用{key === 'BILIBILI_COOKIE_FILE_REF' ? '；清空并保存可移除页面配置的 Cookie' : ''}</small>}
          </label>;
        })}
        {group.tests && <div className="connection-tests">{group.tests.map(kind => {
          const result = data.tests[kind];
          return <div key={kind}><button className="btn" type="button" disabled={busy || dirty} onClick={() => test.mutate(kind)}>{test.isPending && test.variables === kind ? '正在测试…' : '测试 ' + kind.toUpperCase()}</button>
            {result && <p className={result.ok ? 'result-meta' : 'error'} role="status">{result.stale ? '配置已变化，请重新测试。' : ''}{result.message}<br/>{new Date(result.checkedAt).toLocaleString('zh-CN')}</p>}</div>;
        })}</div>}
      </section>)}</div>
      {(save.error || test.error) && <p className="error" role="alert">{(save.error || test.error)?.message}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="actions"><button className="btn primary" disabled={!dirty || busy}>{save.isPending ? '正在保存…' : '保存设置'}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => { setDraft({}); setNotice(''); save.reset(); void query.refetch(); }}>重新加载</button>
        <span className="subtitle">{dirty ? '有未保存修改，请先保存再测试。' : '模型测试会发送短样例，可能产生少量调用费用。'}</span></div>
    </form>
    <PromptManager/>
  </>;
}
function PromptManager() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['prompts'], queryFn: () => api<PromptDto[]>('/prompt-versions'), refetchInterval: false });
  const [selected, setSelected] = useState('');
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; body: string } | null>(null);
  const [notice, setNotice] = useState('');
  const active = query.data?.find(p => p.active);
  const prompt = query.data?.find(p => p.id === selected) || active;
  const values = draft || prompt;
  const mutation = useMutation({ mutationFn: () => api<{ id: string; revision: number }>('/prompt-versions', { name: values!.name, body: values!.body }),
    onSuccess: result => { setSelected(result.id); setDraft(null); setNotice('已启用提示词版本 ' + result.revision + '，已有总结保持原版本关联。'); void client.invalidateQueries({ queryKey: ['prompts'] }); } });
  return <section className="panel prompt-panel"><h2>总结提示词</h2> 
    {switchTo !== null && <ConfirmDialog title="切换提示词版本" confirmLabel="放弃修改并切换" onClose={() => setSwitchTo(null)} onConfirm={async () => { setSelected(switchTo); setDraft(null); }}>切换版本将放弃尚未保存的提示词修改。</ConfirmDialog>}
    {(query.error || mutation.error) && <p className="error" role="alert">{(query.error || mutation.error)?.message}</p>}
    {values && <form onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
      <div className="setting-field">历史版本<Select label="提示词历史版本" value={prompt?.id || ''} disabled={mutation.isPending} onChange={value => { if (draft) setSwitchTo(value); else setSelected(value); }} options={(query.data || []).map(p => ({ value: p.id, label: '版本 ' + p.revision + ' · ' + p.name + (p.active ? ' · 当前启用' : '') }))}/></div>
      <label className="setting-field">提示词名称<input required maxLength={100} value={values.name} disabled={mutation.isPending} onChange={event => setDraft({ name: event.target.value, body: values.body })}/></label>
      <label className="setting-field">系统提示词正文<textarea required maxLength={30000} rows={14} value={values.body} disabled={mutation.isPending} onChange={event => setDraft({ name: values.name, body: event.target.value })}/></label>
      <div className="actions"><button className="btn primary" disabled={mutation.isPending || (!draft && prompt?.active)}>{mutation.isPending ? '正在保存…' : '保存并启用提示词'}</button><span className="subtitle">{values.body.length.toLocaleString()} / 30,000 字符</span></div>
    </form>}
    {notice && <p className="notice" role="status">{notice}</p>}
  </section>;
}
