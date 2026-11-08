export const H1_TELEGRAM_KEY: string;
export function shouldNotifyH1(action: string | null | undefined, previous: string | null | undefined, mode?: string): boolean;
export function notifyH1Decision(env: any, args: { candleKey: string; action: string; text: string; send: (text: string) => Promise<void> }): Promise<{ sent: boolean; reason: string }>;
