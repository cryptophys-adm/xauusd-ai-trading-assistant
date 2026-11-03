// Compact views of knowledge-base v4 for model prompts. Line references are
// for audit (see knowledge-base-v4.json) and are dropped to save tokens.
import { KNOWLEDGE_BASE_V4 } from "./knowledge-base.generated.mjs";

const REF_KEYS = new Set(["ref", "refs"]);
function stripRefs(node) {
  if (Array.isArray(node)) return node.map(stripRefs);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).filter(([k]) => !REF_KEYS.has(k)).map(([k, v]) => [k, stripRefs(v)]));
  }
  return node;
}

const provenanceSummary = {
  knowledge_base_version: KNOWLEDGE_BASE_V4.version,
  content_sha256: KNOWLEDGE_BASE_V4.provenance.content_sha256,
  pine_sources: KNOWLEDGE_BASE_V4.provenance.pine_sources.map(({ path, sha256 }) => ({ path, sha256 }))
};

const VIEWS = {
  technical: JSON.stringify({
    ...stripRefs({ ...KNOWLEDGE_BASE_V4, provenance: undefined, news_policy: undefined }),
    provenance: provenanceSummary
  }),
  news: JSON.stringify({
    version: KNOWLEDGE_BASE_V4.version,
    purpose: "XAUUSD fundamental news analysis policy.",
    news_policy: KNOWLEDGE_BASE_V4.news_policy,
    decision_policy: { recommendation_only: true, automatic_trade_execution: false, prophet_is_base_bias: true },
    provenance: provenanceSummary
  })
};

/** @param {"technical"|"news"} kind */
export function knowledgeForPrompt(kind) {
  return VIEWS[kind] ?? VIEWS.technical;
}
