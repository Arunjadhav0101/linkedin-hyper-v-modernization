import { pino } from 'pino';

export interface LogContext {
  traceId?: string;
  jobId?: string;
  accountId?: string;
  component?: string;
  proxyIp?: string;
  [key: string]: unknown;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      'cookies.li_at',
      'cookies.JSESSIONID',
      'authorization',
      'headers.cookie',
      '*.password',
      '*.cookies.li_at',
    ],
    censor: '[REDACTED]',
  },
});

export function createChildLogger(context: LogContext) {
  return logger.child(context);
}
