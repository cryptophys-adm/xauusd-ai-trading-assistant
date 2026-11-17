export function runKnobProposals(env: unknown, input?: Record<string, any>): Promise<Record<string, any>>;
export function knobEvidence(rows: any[], knobId: string, value: number, input?: Record<string, any>): Record<string, any>;
export function sideUnder(row: Record<string, any>, knobId: string, value: number): string | null;
export function decisionRow(rec: Record<string, any>, setups?: Record<string, any>): Record<string, any>;
export const KNOB_GATE: Record<string, number>;
export const TESTABLE_KNOBS: readonly string[];
export { readKnobOverrides, knobValues, KNOBS_KEY } from "./council-knobs.mjs";
