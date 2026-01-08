import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  MEDIA_ROOT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim().length > 0 ? v : '/media'),
    z.string().min(1)
  ),
  PORT: z.coerce.number().int().positive().default(3000),
  USE_SSL: z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v !== 'string') return undefined;
      const s = v.trim().toLowerCase();
      if (!s) return undefined;
      if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
      if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
      return undefined;
    },
    z.boolean().optional()
  ),
  HTTPS_KEY_PATH: z.string().optional(),
  HTTPS_CERT_PATH: z.string().optional(),
  HTTPS_AUTO_SELF_SIGNED: z.preprocess(
    (v) => {
      // Default to enabled unless explicitly disabled.
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v !== 'string') return undefined;
      const s = v.trim().toLowerCase();
      if (!s) return undefined;
      if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
      if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
      return undefined;
    },
    z.boolean().default(true)
  ),
  CORS_ORIGIN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function readEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
