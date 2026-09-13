import { spawn } from 'node:child_process';
import { DomainError } from '../../domain/src/index.js';

export class ToolError extends DomainError {
  constructor(public output: string, code: string, message: string, retryable = false) { super(code, message, retryable); }
}
export function runTool(executable: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; code?: string;
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const code = options.code || 'MEDIA_TOOL_FAILED';
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = ''; let bytes = 0; let reason: DomainError | undefined;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { child.kill(); });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
    };
    const abort = () => { reason = new DomainError('OPERATION_CANCELED', '处理已中止'); stop(); };
    const timer = setTimeout(() => { reason = new DomainError(code + '_TIMEOUT', '媒体工具执行超时', true); stop(); }, options.timeoutMs ?? 120000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) { reason = new DomainError(code, '媒体工具输出超过限制'); stop(); }
      else stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16000); });
    child.once('error', () => { cleanup(); reject(new DomainError('CONFIG_INVALID', '无法启动媒体工具，请检查 FFmpeg、FFprobe 和 yt-dlp 路径')); });
    child.once('close', exit => { cleanup(); reason ? reject(reason) : exit === 0 ? resolve(stdout) : reject(new ToolError(stderr, code, '媒体处理失败，请检查文件和工具配置')); });
  });
}
