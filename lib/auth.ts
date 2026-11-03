/**
 * @fileoverview Inter-component authentication for Cloudflare Workers.
 *
 * Scheme: HMAC-SHA256 over the canonical request body, bound by a shared
 * secret that exists only as a Worker secret on both sides. Never embedded in
 * payloads, KV, D1, or AI prompts.
 *
 * Replay protection:
 *  - X-Request-Timestamp must lie within CLOCK_TOLERANCE_SECONDS of now.
 *  - X-Request-ID is recorded briefly by the receiver to reject replays.
 */

import { sha256Hex } from "./contracts.ts";

export const AUTH_SCHEME = "hmac-sha256";
export const CLOCK_TOLERANCE_SECONDS = 5 * 60; // 5 minutes
export const REPLAY_RECORD_TTL_SECONDS = 10 * 60; // 10 minutes

export interface SigningInput {
  body: string; // exact UTF-8 body bytes sent on the wire
  request_id: string;
  timestamp: string; // ISO-8601 UTC
}

export function canonicalSigningString(input: SigningInput): string {
  return [input.request_id, input.timestamp, input.body].join("\n");
}

export async function signHmac(secret: string, input: SigningInput): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalSigningString(input)));
  return arrayToHex(new Uint8Array(sig));
}

export async function verifyHmac(secret: string, input: SigningInput, signature: string): Promise<boolean> {
  const expected = await signHmac(secret, input);
  return constantTimeCompare(expected, signature);
}

function arrayToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface HandoffHeaders {
  "x-request-id": string;
  "x-request-timestamp": string;
  "x-content-sha256": string;
  "x-signature": string;
  "x-auth-scheme": string;
}

export async function buildHandoffHeaders(secret: string, body: string): Promise<HandoffHeaders> {
  const request_id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const bodySha = await sha256Hex(body);
  const signature = await signHmac(secret, { body, request_id, timestamp });
  return {
    "x-request-id": request_id,
    "x-request-timestamp": timestamp,
    "x-content-sha256": bodySha,
    "x-signature": signature,
    "x-auth-scheme": AUTH_SCHEME,
  };
}

export interface VerifyResult {
  ok: boolean;
  request_id: string | null;
  timestamp: string | null;
  reason: string | null;
}

export async function verifyHandoffRequest(
  secret: string,
  body: string,
  headers: { get(name: string): string | null },
  nowMs: number = Date.now(),
  seenIds?: Set<string>
): Promise<VerifyResult> {
  const scheme = headers.get("x-auth-scheme") || "";
  if (scheme !== AUTH_SCHEME) {
    return { ok: false, request_id: null, timestamp: null, reason: "Unsupported auth scheme" };
  }

  const requestId = headers.get("x-request-id") || "";
  const timestamp = headers.get("x-request-timestamp") || "";
  const signature = headers.get("x-signature") || "";
  const contentSha = headers.get("x-content-sha256") || "";

  if (!requestId || !timestamp || !signature || !contentSha) {
    return { ok: false, request_id: requestId || null, timestamp: timestamp || null, reason: "Missing auth headers" };
  }

  // Replay / request-id dedup.
  if (seenIds && seenIds.has(requestId)) {
    return { ok: false, request_id: requestId, timestamp, reason: "Duplicate request_id (replay)" };
  }

  // Timestamp freshness / replay window.
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) {
    return { ok: false, request_id: requestId, timestamp, reason: "Invalid timestamp" };
  }
  const ageMs = nowMs - ts;
  if (ageMs < 0 || ageMs > CLOCK_TOLERANCE_SECONDS * 1000) {
    return { ok: false, request_id: requestId, timestamp, reason: "Timestamp outside tolerance window" };
  }

  // Content integrity.
  const actualSha = await sha256Hex(body);
  if (actualSha !== contentSha) {
    return { ok: false, request_id: requestId, timestamp, reason: "Content hash mismatch" };
  }

  const ok = await verifyHmac(secret, { body, request_id: requestId, timestamp }, signature);
  if (!ok) {
    return { ok: false, request_id: requestId, timestamp, reason: "Invalid signature" };
  }

  if (seenIds) seenIds.add(requestId);
  return { ok: true, request_id: requestId, timestamp, reason: null };
}
