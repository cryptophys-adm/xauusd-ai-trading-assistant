export const NEURON_ALLOCATION_VERSION: string;
export function blendedRates(usageRows: unknown[]): Map<string, number>;
export function buildAllocation(input: Record<string, unknown>): Record<string, any>;
export function readNeuronAllocation(env: unknown, options?: { days?: number; now?: number }): Promise<Record<string, any>>;
