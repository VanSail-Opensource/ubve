import { BudgetLedger, EngineError, OwnedLease, byteLength, checkOperation, sameEpoch, validatePacket, type Decoder, type EffectiveDecoderConfiguration, type EncodedPacket, type OperationContext, type OwnedOutput, type Reservation, type SessionStamp, type Submission } from '@ubve/core';
import { browserScheduler } from '@ubve/io-demux';

/** Shared ownership protocol. Real subclasses implement only actual codec operations. */
export abstract class PacketDecoder<Payload> implements Decoder<Payload> {
  abstract readonly effective: EffectiveDecoderConfiguration;
  protected stamp: SessionStamp;
  protected terminal = false;
  #resetting = false; #eos = false; #flushing = false; #failure: EngineError | null = null;
  #chain: Promise<void> = Promise.resolve(); #output: OwnedOutput<Payload>[] = [];
  #inputBytes = 0; #inputItems = 0; #readPending = false;
  #inputs = new Set<Promise<void>>(); #closing: Promise<void> | null = null;
  #changes = new Set<() => void>();
  readonly #ledger: BudgetLedger;
  readonly #maxInputBytes: number;
  protected constructor(stamp: SessionStamp, outputBytes: number, outputItems: number, maxInputBytes = 16 * 1024 * 1024) {
    this.stamp = stamp; this.#maxInputBytes = maxInputBytes;
    this.#ledger = new BudgetLedger({ bytes: byteLength(outputBytes), items: outputItems, maxSingleItemBytes: byteLength(outputBytes) });
  }
  protected abstract decode(packet: EncodedPacket, consumed: () => void): Promise<void>;
  protected abstract flush(): Promise<void>;
  protected abstract reopen(): Promise<void>;
  protected abstract shutdown(): Promise<void>;
  protected ensureActive(): void { if (this.#failure) throw this.#failure; if (this.terminal) throw new EngineError('DISPOSED', 'Decoder disposed'); }
  protected changed(): void { const listeners = [...this.#changes]; this.#changes.clear(); for (const listener of listeners) listener(); }
  protected fail(error: unknown): void { this.#failure ??= error instanceof EngineError ? error : new EngineError('INVALID_PACKET', String(error)); this.changed(); }
  async #wait(operation?: OperationContext): Promise<void> {
    this.ensureActive();
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {}, cancelTimer = () => {};
      const cleanup = () => { this.#changes.delete(wake); unsubscribe(); cancelTimer(); };
      const wake = () => { cleanup(); resolve(); };
      this.#changes.add(wake);
      if (operation) {
        unsubscribe = operation.cancellation.subscribe(reason => { cleanup(); reject(reason); });
        cancelTimer = browserScheduler.at(operation.deadlineMs, () => { cleanup(); reject(new EngineError('DEADLINE_EXCEEDED', 'Decoder output wait deadline elapsed')); });
      }
    });
    this.ensureActive();
  }
  trySubmit(packet: EncodedPacket, operation: OperationContext): Submission {
    try {
      this.ensureActive(); checkOperation(operation, browserScheduler); validatePacket(packet);
      if (this.#resetting || !sameEpoch(this.stamp, packet.stamp) || !sameEpoch(this.stamp, operation.stamp)) throw new EngineError('STALE_EPOCH', 'Decoder epoch is not ready for this packet');
      if (this.#eos || this.#flushing) throw new EngineError('INVALID_ARGUMENT', 'Input is sealed for EOS');
      const bytes = packet.bytes.bytes;
      if (bytes > 32 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'Codec packet exceeds 32 MiB');
      // An oversized ordinary packet gets one exclusive slot; never permanent temporary-backpressure.
      if (this.#inputItems >= 8 || (this.#inputItems > 0 && this.#inputBytes + bytes > this.#maxInputBytes)) return { status: 'backpressure', reason: 'bytes' };
      const owned = packet.bytes.move(), accepted = { ...packet, bytes: owned }; this.#inputBytes += bytes; this.#inputItems++;
      let resolve!: () => void, reject!: (error: unknown) => void, settled = false;
      const inputConsumed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      let unsubscribe = () => {}, cancelTimer = () => {};
      const release = () => { if (settled) return; settled = true; owned.release(); this.#inputBytes -= bytes; this.#inputItems--; unsubscribe(); cancelTimer(); this.#inputs.delete(inputConsumed); this.changed(); };
      unsubscribe = operation.cancellation.subscribe(reason => { if (!settled) { this.fail(reason); reject(reason); } });
      cancelTimer = browserScheduler.at(operation.deadlineMs, () => { if (!settled) { const error = new EngineError('DEADLINE_EXCEEDED', 'Accepted codec input deadline elapsed'); this.fail(error); reject(error); } });
      const consumed = () => { if (!settled) { release(); resolve(); } };
      const job = async () => {
        try { this.ensureActive(); checkOperation(operation, browserScheduler); if (!sameEpoch(this.stamp, packet.stamp)) throw new EngineError('STALE_EPOCH', 'Accepted packet belongs to the previous epoch'); await this.decode(accepted, consumed); consumed(); }
        catch (error) { release(); reject(error); this.fail(error); }
      };
      this.#inputs.add(inputConsumed); this.#chain = this.#chain.then(job, job); inputConsumed.catch(() => {});
      return { status: 'accepted', inputConsumed };
    } catch (error) { return { status: 'rejected', error: error instanceof EngineError ? error : new EngineError('INVALID_PACKET', String(error)) }; }
  }
  protected async reserveOutput(bytes: number): Promise<Reservation> {
    this.ensureActive();
    let reservation = this.#ledger.tryReserve(byteLength(bytes));
    while (!reservation) { await this.#wait(); reservation = this.#ledger.tryReserve(byteLength(bytes)); }
    return reservation;
  }
  protected async emit(output: Omit<OwnedOutput<Payload>, 'payload'>, value: Payload, bytes: number, reserved?: Reservation): Promise<void> {
    this.ensureActive();
    const reservation = reserved ?? await this.reserveOutput(bytes);
    if (bytes > reservation.bytes) { reservation.release(); throw new EngineError('ITEM_TOO_LARGE', 'Decoded payload exceeds its pre-reserved output storage'); }
    const payload = OwnedLease.adopt(reservation, value, () => this.changed());
    if (!sameEpoch(this.stamp, output.stamp)) { payload.release(); return; }
    this.#output.push({ ...output, payload }); this.changed();
  }
  async readOutput(operation: OperationContext): Promise<OwnedOutput<Payload> | null> {
    this.ensureActive(); checkOperation(operation, browserScheduler);
    if (this.#readPending) throw new EngineError('BACKPRESSURE', 'Decoder permits only one output consumer');
    if (!sameEpoch(this.stamp, operation.stamp)) throw new EngineError('STALE_EPOCH', 'Output request uses a stale epoch');
    this.#readPending = true;
    try { for (;;) { this.ensureActive(); checkOperation(operation, browserScheduler); if (!sameEpoch(this.stamp, operation.stamp)) throw new EngineError('STALE_EPOCH', 'Decoder epoch changed during read'); const output = this.#output.shift(); if (output) { this.changed(); return output; } if (this.#eos) return null; await this.#wait(operation); } }
    finally { this.#readPending = false; }
  }
  async drain(operation: OperationContext): Promise<void> { checkOperation(operation, browserScheduler); const accepted = [...this.#inputs]; await Promise.all(accepted); this.ensureActive(); checkOperation(operation, browserScheduler); }
  async flushEndOfStream(operation: OperationContext): Promise<void> {
    this.ensureActive(); checkOperation(operation, browserScheduler); if (this.#eos) return;
    this.#flushing = true;
    const work = this.#chain.then(async () => { this.ensureActive(); await this.flush(); this.#eos = true; this.changed(); });
    this.#chain = work.catch(error => { this.fail(error); }); await work;
  }
  async reset(next: SessionStamp, operation: OperationContext): Promise<void> {
    checkOperation(operation, browserScheduler); if (this.terminal) throw new EngineError('DISPOSED', 'Disposed decoder cannot reset');
    this.#resetting = true; this.stamp = next; this.#failure = new EngineError('STALE_EPOCH', 'Decoder resetting'); this.changed();
    for (const output of this.#output) output.payload.release(); this.#output = [];
    await this.shutdown(); await this.#chain; this.#failure = null; this.#eos = false; this.#flushing = false;
    try { await this.reopen(); checkOperation(operation, browserScheduler); } finally { this.#resetting = false; this.changed(); }
  }
  dispose(): Promise<void> {
    if (this.#closing) return this.#closing; this.terminal = true; this.changed();
    for (const output of this.#output) output.payload.release(); this.#output = [];
    this.#closing = (async () => { try { await this.shutdown(); } finally { await this.#chain; this.changed(); } })();
    return this.#closing;
  }
  snapshot() { return { inputBytes: this.#inputBytes, inputItems: this.#inputItems, output: this.#ledger.snapshot(), queuedOutputs: this.#output.length, eos: this.#eos, failure: this.#failure?.code ?? null }; }
}
