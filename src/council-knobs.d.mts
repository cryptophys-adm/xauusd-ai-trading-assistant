export const KNOB_REGISTRY: ReadonlyArray<{ id: string; label: string; current: number; min: number; max: number; step: number; unit: string; applies: string }>;
export const KNOBS_KEY: string;
export function knobById(id: string): Record<string, any> | null;
export function checkKnobValue(id: string, value: unknown, live?: Record<string, number> | null): Record<string, any>;
export function knobMenu(live?: Record<string, number> | null): Array<Record<string, any>>;
export function knobValues(doc: unknown): Record<string, number>;
export function readKnobOverrides(env: unknown, input?: Record<string, any>): Promise<Record<string, number>>;
export function resetKnobCache(): void;
