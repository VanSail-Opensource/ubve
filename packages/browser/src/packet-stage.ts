import { EngineError } from '@ubve/core';

interface Item<T> {
  readonly value: T;
  release(): void;
}

/** A single-track FIFO. An item retains capacity until its consumer is done,
 * not merely until it is dequeued. The source packet ledger remains authoritative. */
export class PacketStage<T> {
  readonly #queue: Item<T>[] = [];
  #items = 0;
  #bytes = 0;
  readonly maxItems: number;
  readonly maxBytes: number;

  constructor(maxItems: number, maxBytes: number) { this.maxItems = maxItems; this.maxBytes = maxBytes; }

  get empty(): boolean { return this.#queue.length === 0; }

  canEnqueue(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) {
      throw new EngineError('ITEM_TOO_LARGE', 'Compressed packet exceeds the selected managed track staging limit');
    }
    return this.#items < this.maxItems && this.#bytes + bytes <= this.maxBytes;
  }

  enqueue(value: T, bytes: number, releaseValue: () => void): void {
    if (!this.canEnqueue(bytes)) throw new EngineError('BACKPRESSURE', 'Managed packet stage is full');
    let released = false;
    this.#items++;
    this.#bytes += bytes;
    this.#queue.push({ value, release: () => {
      if (released) return;
      released = true;
      this.#items--;
      this.#bytes -= bytes;
      releaseValue();
    } });
  }

  take(): Item<T> | undefined { return this.#queue.shift(); }

  clear(): void { for (const item of this.#queue.splice(0)) item.release(); }

  snapshot() { return Object.freeze({ items: this.#items, bytes: this.#bytes, waitingItems: this.#queue.length, maxItems: this.maxItems, maxBytes: this.maxBytes }); }
}
