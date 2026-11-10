// Reads pipeline queue depths (Ops page and Prometheus metrics share this).
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

export const PIPELINE_QUEUES = ["probe", "transcode", "thumbnail", "catalog-status"] as const;
export type QueueName = (typeof PIPELINE_QUEUES)[number];

export interface Depth {
  visible: number;
  inFlight: number;
  delayed: number;
}

export function createQueueReader(region: string, prefix: string) {
  const sqs = new SQSClient({ region, requestHandler: { requestTimeout: 10_000, connectionTimeout: 3_000 } });
  const urls = new Map<string, string>();
  const url = async (name: string) => {
    const full = prefix + name;
    if (!urls.has(full)) {
      const out = await sqs.send(new GetQueueUrlCommand({ QueueName: full }));
      urls.set(full, out.QueueUrl!);
    }
    return urls.get(full)!;
  };
  const depthOf = async (name: string): Promise<Depth> => {
    const out = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await url(name),
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
      }),
    );
    const a = out.Attributes ?? {};
    return {
      visible: Number(a.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
      delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
    };
  };
  const all = () =>
    Promise.all(PIPELINE_QUEUES.map(async (name) => ({ name, main: await depthOf(name), dlq: await depthOf(`${name}-dlq`) })));
  return { sqs, url, depthOf, all };
}

export type QueueReader = ReturnType<typeof createQueueReader>;
