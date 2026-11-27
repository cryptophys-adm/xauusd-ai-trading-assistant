export interface TrustedIdentity {
  readonly engine: string;
  readonly source_hash: string;
  readonly implementation_hash: string;
  readonly mizan: { readonly source_hash: string; readonly implementation_hash: string };
}
export interface UntrustedIdentity {
  readonly engine: string;
  readonly source_hash: string;
  readonly implementation_hash: string;
  readonly reason: string;
}
export const TRUSTED_IDENTITIES_VERSION: string;
export const TRUSTED_FROZEN_AT: string;
export const TRUSTED_IDENTITIES: readonly TrustedIdentity[];
export const UNTRUSTED_IDENTITIES: readonly UntrustedIdentity[];
export function frozenTrusted(id: { engine: string; sourceHash?: string | null; implementationHash?: string | null } | null | undefined, table?: readonly TrustedIdentity[]): boolean;
