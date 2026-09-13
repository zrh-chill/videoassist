import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { VideoDto } from '../../../packages/contracts/src/index';
import { sourceName } from './media';
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const names: Record<string, string> = { DISCOVERED: '已发现，待处理', WAITING: '等待处理', FETCHING: '获取视频中', EXTRACTING_AUDIO: '提取音频中', TRANSCRIBING: '转写中', SUMMARIZING: '总结中', COMPLETED: '已完成', FAILED: '处理失败', CANCELED: '已取消' };
function Status({ status }: { status: string }) {
  return <span className={'status ' + (status === 'FAILED' ? 'failed' : status === 'COMPLETED' ? 'done' : ['DISCOVERED', 'WAITING', 'CANCELED'].includes(status) ? 'waiting' : 'running')}>{names[status] || status}</span>;
}
export function VideoByline({ video }: { video: VideoDto }) {
  return <span className="video-byline">{video.creatorName || (video.sourceType === 'LOCAL' ? '本地上传' : '未知 UP 主')} · {sourceName[video.sourceType]} · {video.publishedAt ? new Date(video.publishedAt).toLocaleDateString('zh-CN') : '发布日期未知'}</span>;
}
export function VideoCover({ video }: { video: VideoDto }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  let cover: string | null = null;
  try { const url = new URL(video.coverUrl || ''); if (['http:', 'https:'].includes(url.protocol)) { url.protocol = 'https:'; cover = url.href; } } catch { /* No cover available. */ }
  const seconds = video.durationMs == null ? null : Math.floor(video.durationMs / 1000);
  const duration = seconds == null ? null : (seconds >= 3600 ? Math.floor(seconds / 3600) + ':' : '') + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  return <span className="video-cover">{cover && failedUrl !== cover ? <img src={cover} alt={video.title + '的封面'} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(cover)}/> : <span className="cover-empty">暂无封面</span>}{duration && <span className="cover-duration">{duration}</span>}</span>;
}
export function VideoTable({ items, loading = false, empty = '暂无视频记录' }: { items: VideoDto[]; loading?: boolean; empty?: React.ReactNode }) {
  return <div className="table-wrap video-table"><table><thead><tr><th>视频</th><th>当前状态</th><th>创建时间</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{items.map(video => <tr key={video.id}>
        <td><Link className="video-link" to={'/videos/' + video.id}><VideoCover video={video}/><span className="video-copy"><strong title={video.title}>{video.title}</strong><VideoByline video={video}/><span className="video-excerpt" title={video.oneSentence || undefined}>{video.oneSentence || '暂无一句话总结'}</span></span></Link></td>
        <td><Status status={video.overallStatus}/></td><td className="mono"><time dateTime={video.createdAt} title={time(video.createdAt)}>{new Date(video.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></td><td><Link className="icon-btn" aria-label={'查看详情：' + video.title} title="查看详情" to={'/videos/' + video.id}>↗</Link></td>
      </tr>)}</tbody></table>
      {loading && <div className="empty">正在读取任务…</div>}
      {!loading && !items.length && <div className="empty">{empty}</div>}
    </div>;
}
