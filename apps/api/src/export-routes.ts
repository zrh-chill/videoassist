import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../packages/database/src/client.js';
import { listQuerySchema } from '../../../packages/contracts/src/index.js';
import { videoWhere } from '../../../packages/database/src/video-query.js';
import { z } from 'zod';

export function excelText(input: string | null | undefined) {
  let value = (input || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (/^\s*[=+@-]/.test(value)) value = "'" + value;
  const truncated = value.length > 32767;
  value = value.slice(0, 32767);
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  return { value, truncated };
}
const headers = ['视频 ID', '标题', '来源', 'BVID', '原始链接', 'UP 主', '时长（秒）', '发布时间', '状态', '当前阶段', '创建时间', '文稿版本', '完整文稿', '文稿是否截断', '总结版本', '一句话总结', '核心要点', '详细总结', '关键词', '总结是否截断', '转写模型', '总结模型', '提示词版本 ID', '错误信息'];
export async function writeExport(db: Database, query: z.infer<typeof listQuerySchema>, history: boolean, output: PassThrough) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet('视频');
  sheet.addRow(headers).commit();
  const runs = history ? workbook.addWorksheet('处理记录') : undefined;
  runs?.addRow(['视频 ID', '阶段', '尝试次数', '状态', '开始时间', '结束时间', '耗时（秒）', '错误代码', '错误信息']).commit();
  const where = videoWhere(query);
  // Keyset paging ignores the list cursor: export every match, not just the visible page.
  const cutoff = new Date();
  let cursor: { id: string; createdAt: Date } | undefined;
  try {
    while (!output.destroyed) {
      const items = await db.video.findMany({ where: { AND: [where, { createdAt: { lte: cutoff } },
        ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] : [])] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25,
        include: { transcripts: { where: { isCurrent: true }, take: 1 }, summaries: { where: { isCurrent: true }, take: 1 } },
      });
      if (!items.length) break;
      for (const video of items) {
        if (output.destroyed) return;
        const transcript = video.transcripts[0]; const summary = video.summaries[0];
        const content = summary ? JSON.parse(summary.structuredJson) : {};
        const fullText = excelText(transcript?.fullText);
        const summaryParts = [content.one_sentence, (content.key_points || []).join('\n'), content.detailed_summary, (content.keywords || []).join('、')].map(excelText);
        const values = [video.id, video.title, video.sourceType, video.bvid, video.originalUrl, video.creatorName,
          video.durationMs == null ? '' : video.durationMs / 1000, video.publishedAt?.toISOString(), video.overallStatus, video.currentStage, video.createdAt.toISOString(),
          transcript?.revision, fullText.value, fullText.truncated ? '是' : '否', summary?.revision,
          ...summaryParts.map(p => p.value), summaryParts.some(p => p.truncated) ? '是' : '否',
          transcript?.model, summary?.model, summary?.promptVersionId, video.latestErrorMessage];
        // Pre-sanitized text is harmless on a second pass (it starts with an apostrophe).
        sheet.addRow(values.map(value => typeof value === 'number' ? value : excelText(value).value)).commit();
        if (runs) {
          let runCursor: string | undefined;
          while (!output.destroyed) {
            const batch = await db.stageRun.findMany({ where: { videoId: video.id }, orderBy: { id: 'asc' }, take: 100, ...(runCursor ? { cursor: { id: runCursor }, skip: 1 } : {}) });
            for (const run of batch) runs.addRow([video.id, run.stage, run.attempt, run.status, run.startedAt.toISOString(), run.finishedAt?.toISOString() || '',
              run.finishedAt ? (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000 : '', run.errorCode || '', run.errorMessage || ''].map(v => typeof v === 'number' ? v : excelText(v).value)).commit();
            if (batch.length < 100) break;
            runCursor = batch.at(-1)!.id;
          }
        }
      }
      cursor = items.at(-1)!;
      await setImmediate();
    }
    if (output.destroyed) return;
    sheet.commit(); runs?.commit(); await workbook.commit();
  } finally {
    // Stop compression if the client disconnects during generation.
    if (output.destroyed && !output.writableFinished) (workbook as unknown as { zip: { abort(): void } }).zip.abort();
  }
}
export function exportRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/exports/videos.xlsx', async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const { history } = z.object({ history: z.enum(['true', 'false']).default('false') }).parse(request.query);
    const output = new PassThrough();
    output.on('error', () => {});
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', 'attachment; filename="framenote-videos.xlsx"');
    reply.header('Cache-Control', 'no-store');
    reply.raw.once('close', () => { if (!output.destroyed) output.destroy(); });
    void writeExport(db, query, history === 'true', output).catch(() => output.destroy(new Error('导出失败，请重试')));
    return reply.send(output);
  });
}
