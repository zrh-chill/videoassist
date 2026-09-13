import type { Prisma } from '@prisma/client';
export function videoWhere(query: { q: string; status?: string; sourceType?: string }): Prisma.VideoWhereInput {
  return {
    ...(query.q ? { title: { contains: query.q } } : {}),
    ...(query.status ? { overallStatus: query.status } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
  };
}
