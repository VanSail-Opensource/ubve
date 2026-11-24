import { EngineError } from '@ubve/core';

export class CodecWorkerClient {
  readonly worker: Worker;
  #sequence = 0; #failure: EngineError | null = null; #terminated = false;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(url: URL | string, type: WorkerType = 'classic') {
    this.worker = new Worker(url, { type, name: 'ubve-owned-codec' });
    this.worker.onmessage = event => {
      const message = event.data as { id?: number; success?: boolean; data?: unknown; error?: unknown };
      if (!Number.isSafeInteger(message.id)) { this.terminate(new EngineError('INVALID_PACKET', 'Codec worker returned an invalid response identifier')); return; }
      const pending = this.#pending.get(message.id!); if (!pending) return;
      this.#pending.delete(message.id!); clearTimeout(pending.timer);
      if (message.success === true) pending.resolve(message.data);
      else { const error = message.error as { message?: string } | undefined; pending.reject(new EngineError('INVALID_PACKET', error?.message ?? 'Codec worker rejected the command')); }
    };
    this.worker.onerror = event => this.terminate(new EngineError('INTERNAL', event.message || 'Codec worker crashed'));
    this.worker.onmessageerror = () => this.terminate(new EngineError('INVALID_PACKET', 'Codec worker response could not be deserialized'));
  }
  call<T>(type: string, data: unknown = {}, transfer: Transferable[] = [], timeoutMs = 2000): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending.size >= 8) return Promise.reject(new EngineError('BACKPRESSURE', 'Codec command queue exceeds eight pending commands'));
    const id = ++this.#sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(new EngineError('DEADLINE_EXCEEDED', `Codec ${type} exceeded its finite command budget`)), timeoutMs);
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.worker.postMessage({ id, command: { type, data } }, transfer); }
      catch (error) { this.terminate(error instanceof EngineError ? error : new EngineError('INTERNAL', String(error))); }
    });
  }
  terminate(reason = new EngineError('DISPOSED', 'Owned codec worker terminated')): void {
    this.#failure ??= reason;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(this.#failure); }
    this.#pending.clear();
    if (!this.#terminated) { this.#terminated = true; this.worker.terminate(); }
  }
  snapshot() { return { pendingCommands: this.#pending.size, terminationRequested: this.#terminated, physicalThreadExitAcknowledged: false, failure: this.#failure?.code ?? null }; }
}
