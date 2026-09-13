import type { Prisma } from '@prisma/client';
export function videoWhere(query: { q: string; status?: string; sourceType?: string; creatorId?: string }): Prisma.VideoWhereInput {
  return {
    isDeleted: false,
    ...(query.creatorId ? { creatorId: query.creatorId } : {}),
    ...(query.q ? { title: { contains: query.q } } : {}),
    ...(query.status ? { overallStatus: query.status } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
  };
}
