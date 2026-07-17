import { prisma } from '../core/db.js';

export async function logEvent(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: any) {
  try {
    await prisma.log.create({
      data: {
        level,
        message,
        meta: meta ? (typeof meta === 'object' ? meta : { data: meta }) : undefined,
      },
    });
  } catch (e) {
    console.error('[Logger] Failed to write to DB Log:', e);
  }
}
