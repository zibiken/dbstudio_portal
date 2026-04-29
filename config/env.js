import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1024).max(65535),
  HOST: z.string().min(1),
  DATABASE_URL: z.string().url().startsWith('postgres://'),
  MASTER_KEY_PATH: z.string().startsWith('/'),
  SESSION_SIGNING_SECRET: z.string().min(32),
  FILE_URL_SIGNING_SECRET: z.string().min(32),
  MAILERSEND_API_KEY: z.string().min(1),
  MAILERSEND_FROM_EMAIL: z.string().email(),
  MAILERSEND_FROM_NAME: z.string().default('DB Studio Portal'),
  ADMIN_NOTIFICATION_EMAIL: z.string().email(),
  PORTAL_BASE_URL: z.string().url().startsWith('https://'),
  NDA_TEMPLATE_PATH: z.string().startsWith('/'),
  PDF_SERVICE_SOCKET: z.string().startsWith('/'),
  BACKUP_RCLONE_REMOTE: z.string().optional(),
  AGE_RECIPIENTS_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

export function loadEnv(source = process.env) {
  return schema.parse(source);
}
