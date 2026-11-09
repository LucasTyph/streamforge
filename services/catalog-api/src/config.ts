import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().url(),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT_URL_S3: z.string().url().optional(),
  AWS_ENDPOINT_URL_SNS: z.string().url().optional(),
  /** Endpoint baked into presigned URLs; must be reachable from the browser. */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  RAW_BUCKET: z.string(),
  VIDEO_UPLOADED_TOPIC_ARN: z.string(),
  CATALOG_STATUS_QUEUE_URL: z.string().url(),
  /** Tasks that must succeed before a video is READY. */
  REQUIRED_TASKS: z
    .string()
    .default("probe,transcode,thumbnail")
    .transform((s) => s.split(",").map((t) => t.trim()).filter(Boolean)),
  /** Browser-facing base URL of the processed bucket (a CDN in production). */
  PROCESSED_PUBLIC_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  QUEUE_PREFIX: z.string().default("streamforge-"),
  ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(200 * 1024 * 1024),
  UPLOAD_PART_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).default(8 * 1024 * 1024),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
