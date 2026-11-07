import type { EvidenceBundle } from "../lib/contracts.ts";

export type QueueTask =
  | {
      kind: "webhook_reconcile";
      event_id: string;
      candle_key: string;
      source: string;
      ticker: string;
      timeframe: string;
      enqueued_at: string;
    }
  | {
      kind: "local_calculation_reconcile";
      event_id: string;
      candle_key: string;
      engine: string;
      ticker: string;
      timeframe: string;
      candle_time: string;
      enqueued_at: string;
    }
  | {
      kind: "analysis";
      event_id: string;
      request_id: string;
      candle_key: string;
      enqueued_at: string;
      bundle: EvidenceBundle;
    }
  | {
      kind: "news_thread";
      event_id: string;
      analysis_key: string;
      candle_key: string;
      enqueued_at: string;
    }
  | {
      kind: "live_room";
      event_id: string;
      bar_time: string;
      candle_key: string;
      context: Record<string, unknown> | null;
      hud?: Record<string, unknown> | null;
      enqueued_at: string;
    }
  | {
      kind: "hud_agents";
      event_id: string;
      candle_key: string;
      enqueued_at: string;
    }
  | {
      kind: "h1_room";
      event_id: string;
      candle_key: string;
      enqueued_at: string;
    }
  | {
      kind: "multi_agent_bus";
      event_id: string;
      candle_key: string;
      input_fingerprint: string;
      enqueued_at: string;
    };

export interface QueueRuntimeMessage<T> {
  id: string;
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
export interface QueueRuntimeBatch<T> {
  messages: readonly QueueRuntimeMessage<T>[];
}

export function buildWebhookQueueTask(input: {
  candleKey: string; source: string; ticker: string; timeframe: string; enqueuedAt?: string;
}): Extract<QueueTask, { kind: "webhook_reconcile" }>;
export function buildLocalCalculationQueueTask(input: {
  candleKey: string; engine: string; ticker: string; timeframe: string; candleTime: string; enqueuedAt?: string;
}): Extract<QueueTask, { kind: "local_calculation_reconcile" }>;
export function sendQueueTask(queue: Queue<QueueTask>, task: QueueTask): Promise<void>;
export function createQueueConsumer(
  processTask: (task: QueueTask) => Promise<void>,
  options?: {
    retryDelaySeconds?: number;
    onFailure?: (details: { messageId: string; attempts: number; kind?: string; errorName: string }) => void;
  }
): (batch: QueueRuntimeBatch<QueueTask>) => Promise<void>;
