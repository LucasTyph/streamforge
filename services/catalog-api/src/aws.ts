import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { Context } from "@opentelemetry/api";
import type { Config } from "./config.js";
import { injectContext } from "./telemetry.js";
import type { CompletedPart } from "./uploads.js";

/** Object storage operations the API needs. Faked in unit tests. */
export interface Storage {
  createMultipart(key: string, contentType: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  objectSize(key: string): Promise<number | undefined>;
  ready(): Promise<void>;
}

export interface VideoUploadedEvent {
  videoId: string;
  ownerId: string;
  bucket: string;
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface Events {
  /** `ctx`: the trace this video's pipeline continues (the upload-complete request). */
  videoUploaded(e: VideoUploadedEvent, ctx?: Context | null): Promise<void>;
}

const timeouts = { requestTimeout: 10_000, connectionTimeout: 3_000 };

export function createStorage(cfg: Config): Storage {
  const base = {
    region: cfg.AWS_REGION,
    forcePathStyle: true,
    requestHandler: timeouts,
    // Default "WHEN_SUPPORTED" bakes a CRC32 of the *empty* body into presigned URLs,
    // so the browser's real upload fails with BadDigest (on real S3 too).
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
  };
  // The SDK reads AWS_ENDPOINT_URL_S3 itself; the presigner needs the browser-facing endpoint.
  const s3 = new S3Client(base);
  const presigner = new S3Client({ ...base, endpoint: cfg.S3_PUBLIC_ENDPOINT ?? cfg.AWS_ENDPOINT_URL_S3 });
  const Bucket = cfg.RAW_BUCKET;

  return {
    async createMultipart(Key, ContentType) {
      const out = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
      if (!out.UploadId) throw new Error("S3 returned no UploadId");
      return out.UploadId;
    },
    presignPart(Key, UploadId, PartNumber, expiresIn) {
      return getSignedUrl(presigner, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn });
    },
    async completeMultipart(Key, UploadId, parts) {
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    },
    async abortMultipart(Key, UploadId) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
    },
    async objectSize(Key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket, Key }));
        return out.ContentLength;
      } catch (err) {
        if ((err as { name?: string }).name === "NotFound") return undefined;
        throw err;
      }
    },
    async ready() {
      await s3.send(new HeadBucketCommand({ Bucket }));
    },
  };
}

export function createEvents(cfg: Config): Events {
  const sns = new SNSClient({ region: cfg.AWS_REGION, requestHandler: timeouts });
  return {
    async videoUploaded(e, ctx) {
      const trace = Object.fromEntries(
        Object.entries(injectContext(ctx)).map(([k, v]) => [k, { DataType: "String", StringValue: v }]),
      );
      await sns.send(
        new PublishCommand({
          TopicArn: cfg.VIDEO_UPLOADED_TOPIC_ARN,
          Message: JSON.stringify({ type: "video.uploaded", version: 1, ...e }),
          MessageAttributes: { type: { DataType: "String", StringValue: "video.uploaded" }, ...trace },
        }),
      );
    },
  };
}
