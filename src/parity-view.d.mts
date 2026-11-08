export function engineTimeframe(engine: string): string;
export function engineBase(engine: string): string;
export function shapeRegistry(rows: any[]): any[];
export function readParityView(db: any, options?: { now?: number; limit?: number }): Promise<Record<string, any>>;
