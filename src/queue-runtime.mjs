/**
 * Queue primitives shared by the webhook producer and consumer.
 * Event ids are deterministic; D1 analysis_runs remains the durable
 * idempotency gate for downstream AI synthesis.
 */
export function buildWebhookQueueTask(input) {
  const { candleKey, source, ticker, timeframe, enqueuedAt = new Date().toISOString() } = input ?? {};
  if (![candleKey, source, ticker, timeframe].every(value => typeof value === "string" && value.trim())) {
    throw new TypeError("webhook queue task requires candleKey, source, ticker, and timeframe");
  }
  return {
    kind: "webhook_reconcile",
    event_id: `webhook:${candleKey}:${source}`,
    candle_key: candleKey,
    source,
    ticker,
    timeframe,
    enqueued_at: enqueuedAt
  };
}

export function buildLocalCalculationQueueTask(input) {
  const { candleKey, engine, ticker, timeframe, candleTime, enqueuedAt = new Date().toISOString() } = input ?? {};
  if (![candleKey, engine, ticker, timeframe, candleTime].every(value => typeof value === "string" && value.trim())) {
    throw new TypeError("local calculation queue task requires candleKey, engine, ticker, timeframe, and candleTime");
  }
  return {
    kind: "local_calculation_reconcile",
    event_id: `localcalc:${candleKey}:${engine}`,
    candle_key: candleKey,
    engine,
    ticker,
    timeframe,
    candle_time: candleTime,
    enqueued_at: enqueuedAt
  };
}

export async function sendQueueTask(queue, task) {
  if (!queue || typeof queue.send !== "function") {
    throw new TypeError("durable queue binding is not configured");
  }
  await queue.send(task, { contentType: "json" });
}

export function createQueueConsumer(processTask, options = {}) {
  if (typeof processTask !== "function") throw new TypeError("processTask must be a function");
  const retryDelaySeconds = Number.isInteger(options.retryDelaySeconds) && options.retryDelaySeconds >= 0
    ? options.retryDelaySeconds
    : 30;
  const onFailure = typeof options.onFailure === "function" ? options.onFailure : () => {};
  return async function consume(batch) {
    for (const message of batch.messages) {
      try {
        await processTask(message.body);
        message.ack();
      } catch (error) {
        try {
          onFailure({
            messageId: message.id,
            attempts: message.attempts,
            kind: message.body?.kind,
            errorName: error instanceof Error ? error.name : "UnknownError"
          });
        } catch {
          // Logging failure must not prevent retry.
        }
        message.retry({ delaySeconds: retryDelaySeconds });
      }
    }
  };
}

export function buildMultiAgentBusQueueTask(input) {
  const { candleKey, inputFingerprint, enqueuedAt = new Date().toISOString() } = input ?? {};
  if (typeof candleKey !== "string" || !candleKey.trim() || typeof inputFingerprint !== "string" || !inputFingerprint.trim()) {
    throw new TypeError("multi-agent bus queue task requires candleKey and inputFingerprint");
  }
  return {
    kind: "multi_agent_bus",
    event_id: `bus:${candleKey}:${inputFingerprint}`,
    candle_key: candleKey,
    input_fingerprint: inputFingerprint,
    enqueued_at: enqueuedAt
  };
}
