/**
 * @fileoverview Validation helpers for evidence bundles.
 *
 * Pure functions used by the Confluence Controller (sender) and the AI Worker
 * (receiver). No secrets, no side effects.
 */

import type { EvidenceBundle, EngineId } from "./contracts.ts";
import {
  isDecision,
  isEngineId,
  isTimeframe,
  REQUIRED_ENGINES,
  SCHEMA_VERSION,
} from "./contracts.ts";

export interface ValidationProblem {
  field: string;
  reason: string;
}

export function validateCandleRef(candle: unknown): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const c = candle as Record<string, unknown> | null;
  if (!c || typeof c !== "object") {
    return [{ field: "candle", reason: "candle must be an object" }];
  }
  if (typeof c.symbol !== "string" || c.symbol.trim().length === 0) {
    problems.push({ field: "candle.symbol", reason: "required non-empty string" });
  }
  if (!isTimeframe(c.timeframe)) {
    problems.push({ field: "candle.timeframe", reason: "must be one of M1, M5, M15, H1, H4, D1" });
  }
  if (typeof c.candle_ts !== "string" || c.candle_ts.trim().length === 0) {
    problems.push({ field: "candle.candle_ts", reason: "required non-empty ISO-8601 string" });
  } else if (isNaN(new Date(c.candle_ts as string).getTime())) {
    problems.push({ field: "candle.candle_ts", reason: "invalid ISO-8601 timestamp" });
  }
  if (typeof c.candle_key !== "string" || c.candle_key.trim().length === 0) {
    problems.push({ field: "candle.candle_key", reason: "required non-empty string" });
  }
  return problems;
}

export function validateEngineResult(er: unknown): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const e = er as Record<string, unknown> | null;
  if (!e || typeof e !== "object") {
    return [{ field: "engine", reason: "each engine result must be an object" }];
  }
  if (!isEngineId(e.engine)) {
    problems.push({ field: "engine", reason: "must be one of mizan, prophet, gmi" });
  }
  if (typeof e.version !== "string" || e.version.trim().length === 0) {
    problems.push({ field: "engine.version", reason: "required non-empty string" });
  }
  if (e.source_hash !== null && typeof e.source_hash !== "string") {
    problems.push({ field: "engine.source_hash", reason: "string or null" });
  }
  if (typeof e.computed_at !== "string" || isNaN(new Date(e.computed_at as string).getTime())) {
    problems.push({ field: "engine.computed_at", reason: "valid ISO-8601 required" });
  }
  if (typeof e.ok !== "boolean") {
    problems.push({ field: "engine.ok", reason: "boolean required" });
  }
  if (typeof e.error !== "string" && e.error !== null) {
    problems.push({ field: "engine.error", reason: "string or null" });
  }
  if (e.freshness_seconds !== null && (typeof e.freshness_seconds !== "number" || !Number.isFinite(e.freshness_seconds))) {
    problems.push({ field: "engine.freshness_seconds", reason: "finite number or null" });
  }
  if (typeof e.production_ready !== "boolean") {
    problems.push({ field: "engine.production_ready", reason: "boolean required" });
  }
  return problems;
}

export function validateNewsEvidence(news: unknown): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const n = news as Record<string, unknown> | null;
  if (!n || typeof n !== "object") {
    return [{ field: "news", reason: "news must be an object" }];
  }
  if (typeof n.available !== "boolean") {
    problems.push({ field: "news.available", reason: "boolean required" });
  }
  if (typeof n.article_count !== "number" || !Number.isFinite(n.article_count)) {
    problems.push({ field: "news.article_count", reason: "finite number required" });
  }
  if (!Array.isArray(n.articles)) {
    problems.push({ field: "news.articles", reason: "array required" });
  }
  if (typeof n.fresh !== "boolean") {
    problems.push({ field: "news.fresh", reason: "boolean required" });
  }
  return problems;
}

export function validateBundle(bundle: unknown): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const b = bundle as Record<string, unknown> | null;
  if (!b || typeof b !== "object") {
    return [{ field: "bundle", reason: "must be an object" }];
  }
  if (b.schema_version !== SCHEMA_VERSION) {
    problems.push({ field: "schema_version", reason: `must equal ${SCHEMA_VERSION}` });
  }
  if (typeof b.request_id !== "string" || b.request_id.trim().length === 0) {
    problems.push({ field: "request_id", reason: "required non-empty string" });
  }
  if (typeof b.created_at !== "string" || isNaN(new Date(b.created_at as string).getTime())) {
    problems.push({ field: "created_at", reason: "valid ISO-8601 required" });
  }
  if (typeof b.symbol !== "string" || b.symbol.trim().length === 0) {
    problems.push({ field: "symbol", reason: "required non-empty string" });
  }
  if (!isTimeframe(b.timeframe)) {
    problems.push({ field: "timeframe", reason: "must be one of M1, M5, M15, H1, H4, D1" });
  }
  problems.push(...validateCandleRef(b.candle));
  const validation = b.validation as Record<string, unknown> | null;
  if (!validation || typeof validation !== "object") {
    problems.push({ field: "validation", reason: "object required" });
  } else {
    if (typeof validation.ok !== "boolean") {
      problems.push({ field: "validation.ok", reason: "boolean required" });
    }
    if (validation.completeness !== "complete" && validation.completeness !== "incomplete") {
      problems.push({ field: "validation.completeness", reason: "'complete' or 'incomplete'" });
    }
    if (!Array.isArray(validation.errors)) {
      problems.push({ field: "validation.errors", reason: "array required" });
    }
    if (!Array.isArray(validation.missing_evidence)) {
      problems.push({ field: "validation.missing_evidence", reason: "array required" });
    }
    const freshness = validation.freshness as Record<string, unknown> | null;
    if (freshness && typeof freshness === "object") {
      for (const engine of REQUIRED_ENGINES) {
        const fe = freshness[engine] as Record<string, unknown> | null;
        if (!fe || typeof fe !== "object") {
          problems.push({ field: `validation.freshness.${engine}`, reason: "object required" });
          continue;
        }
        if (typeof fe.ok !== "boolean") {
          problems.push({ field: `validation.freshness.${engine}.ok`, reason: "boolean required" });
        }
        if (fe.age_seconds !== null && (typeof fe.age_seconds !== "number" || !Number.isFinite(fe.age_seconds))) {
          problems.push({ field: `validation.freshness.${engine}.age_seconds`, reason: "finite number or null" });
        }
      }
    }
  }
  if (!Array.isArray(b.sources)) {
    problems.push({ field: "sources", reason: "array required" });
  } else {
    for (const s of b.sources as unknown[]) {
      const se = s as Record<string, unknown> | null;
      if (!se || typeof se !== "object") {
        problems.push({ field: "sources[]", reason: "object required" });
        continue;
      }
      if (!isEngineId(se.engine)) {
        problems.push({ field: "sources[].engine", reason: "must be mizan, prophet, or gmi" });
      }
      if (typeof se.provenance !== "string" || se.provenance.trim().length === 0) {
        problems.push({ field: "sources[].provenance", reason: "required non-empty string" });
      }
      if (typeof se.provenance_verified !== "boolean") {
        problems.push({ field: "sources[].provenance_verified", reason: "boolean required" });
      }
      if (typeof se.fresh