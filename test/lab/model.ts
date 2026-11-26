export interface Fixture {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly name: string;
  readonly mime: string;
  readonly quality: 'full' | 'performance';
  readonly expected: Readonly<Partial<Record<'videoFrames' | 'pcmFrames' | 'subtitleEvents' | 'fonts', number>>>;
  readonly audioSampleRate: number | null;
  readonly discClip: Readonly<{ title: number; clip: number }> | null;
}
export interface Job {
  readonly id: string;
  readonly state: string;
  readonly build: { readonly id: string };
  readonly fixture: Fixture;
  readonly route: 'C1';
  readonly scenario: 'lifecycle' | 'timing';
  readonly transport: 'file' | 'range';
  readonly av1: 'automatic' | 'portable';
  readonly foldDown: boolean;
  readonly prefetchCanvas: boolean;
  readonly deadline: number;
}
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item), signal: AbortSignal.timeout(4000) } : { signal: AbortSignal.timeout(4000) });
  const value: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, (value as { error?: string }).error ?? `Lab HTTP ${response.status}`);
  return value as T;
}
export const el = <T extends HTMLElement>(id: string): T => {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing lab element ${id}`);
  return target as T;
};
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
