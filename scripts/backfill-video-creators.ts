import { loadConfig } from '../packages/config/src/index.js';
import { createDatabase } from '../packages/database/src/client.js';
import { resolveVideoCreator } from '../packages/integrations/src/bilibili.js';
const db = createDatabase(loadConfig().databaseUrl);
try {
  const videos = await db.video.findMany({ where: { sourceType: 'BILIBILI', isDeleted: false, creatorUid: null }, select: { id: true, bvid: true } });
  for (const video of videos) {
    if (!video.bvid) continue;
    try {
      const metadata = await resolveVideoCreator(video.bvid);
      await db.$transaction(async tx => {
        const creator = await tx.creator.findFirst({ where: { uid: metadata.creatorUid, deletedAt: null } });
        await tx.video.updateMany({ where: { id: video.id, isDeleted: false }, data: { ...metadata, creatorId: creator?.id } });
      });
      console.log(video.bvid + ': 已同步 UP 主');
    } catch { console.error(video.bvid + ': 查询受限，可稍后重新执行'); process.exitCode = 1; }
  }
} finally { await db.$disconnect(); }
