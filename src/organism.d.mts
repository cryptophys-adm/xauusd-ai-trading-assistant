export const ORGANISM_SCHEMA: string;
export function organismDna(deployed?: { service: string; commit?: string; at?: string } | null): { schema: string; organs: Record<string, any>[]; agents_inventory?: { href: string; schema: string; count: number } };
