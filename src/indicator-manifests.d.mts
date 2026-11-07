export const MANIFEST_VERSION: string;
export const MANIFESTS: ReadonlyArray<Record<string, any>>;
export const HUD_MANIFESTS: ReadonlyArray<Record<string, any>>;
export const MANIFEST_FAMILIES: Readonly<Record<string, string>>;
export function manifestOf(id: string): Record<string, any> | null;
