import { prisma } from '../core/db.js';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const MAX_LOG_ENTRIES = 500;

/**
 * Lightweight database logger.
 * Writes important bot events to the `Log` table (fire-and-forget).
 * Automatically trims oldest entries when the log table exceeds MAX_LOG_ENTRIES.
 */
async function writeLog(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  try {
    await prisma.log.create({
      data: {
        level,
        message,
        meta: meta ? (meta as any) : undefined,
      }
    });

    // Trim old logs to keep DB lean
    const count = await prisma.log.count();
    if (count > MAX_LOG_ENTRIES) {
      const oldest = await prisma.log.findMany({
        orderBy: { createdAt: 'asc' },
        take: count - MAX_LOG_ENTRIES,
        select: { id: true }
      });
      if (oldest.length > 0) {
        await prisma.log.deleteMany({
          where: { id: { in: oldest.map(l => l.id) } }
        });
      }
    }
  } catch (e) {
    // Never let logger errors crash the main flow
    console.error('[DbLogger] Failed to write log to DB:', e);
  }
}

export const dbLogger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    console.log(`[INFO] ${message}`);
    writeLog('INFO', message, meta); // fire-and-forget
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    console.warn(`[WARN] ${message}`);
    writeLog('WARN', message, meta);
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    console.error(`[ERROR] ${message}`);
    writeLog('ERROR', message, meta);
  },
};
