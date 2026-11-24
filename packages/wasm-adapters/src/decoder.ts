import { BudgetLedger, EngineError, OwnedLease, byteLength, checkOperation, sameEpoch, validatePacket, type Decoder, type EffectiveDecoderConfiguration, type EncodedPacket, type OperationContext, type OwnedOutput, type Reservation, type SessionStamp, type Submission } from '@ubve/core';
import { browserScheduler } from '@ubve/io-demux';

/** Shared ownership protocol. Real subclasses implement only actual codec operations. */
export abstract class PacketDecoder<Payload> implements Decoder<Payload> {
  abstract readonly effective: EffectiveDecoderConfiguration;
  protected stamp: SessionStamp;
  protected terminal = false;
  #resetting: Promise<void> | null = null; #eos = false; #flushing: Promise<void> | null = null; #failure: EngineError | null = null;
  #chain: Promise<void> = Promise.resolve(); #output: OwnedOutput<Payload>[] = [];
  #inputBytes = 0; #inputItems = 0; #readPending = false;
  #codecConfigurationEpoch: number | null = null;
  #inputs = new Map<Promise<void>, (reason: EngineError) => void>(); #closing: Promise<void> | null = null;
  #runtimeShutdown: Promise<void> | null = null;
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
  protected ensureActive(): void { if (this.terminal) throw new EngineError('DISPOSED', 'Decoder disposed'); if (this.#failure) throw this.#failure; }
  protected changed(): void { const listeners = [...this.#changes]; this.#changes.clear(); for (const listener of listeners) listener(); }
  protected fail(error: unknown): void {
    this.#failure ??= error instanceof EngineError ? error : new EngineError('INVALID_PACKET', String(error));
    for (const reject of this.#inputs.values()) reject(this.#failure);
    this.changed();
  }
  #checkCurrent(operation: OperationContext): void {
    this.ensureActive(); checkOperation(operation, browserScheduler);
    if (!sameEpoch(this.stamp, operation.stamp)) throw new EngineError('STALE_EPOCH', 'Operation does not belong to the current decoder epoch');
  }
  #checkReady(operation: OperationContext): void {
    this.#checkCurrent(operation);
    if (this.#resetting) throw new EngineError('STALE_EPOCH', 'Decoder epoch is not ready');
  }
  #observe(work: Promise<void>, operation: OperationContext, interrupt: (reason: EngineError) => void = () => {}): Promise<void> {
    return new Promise((resolve, reject) => {
      let cancelTimer = () => {}, unsubscribe = () => {};
      const complete = () => { unsubscribe(); cancelTimer(); };
      const stop = (reason: EngineError) => { complete(); interrupt(reason); reject(reason); };
      cancelTimer = browserScheduler.at(operation.deadlineMs, () => stop(new EngineError('DEADLINE_EXCEEDED', 'Decoder operation deadline elapsed')));
      unsubscribe = operation.cancellation.subscribe(stop);
      work.then(() => { complete(); try { this.#checkCurrent(operation); resolve(); } catch (error) { reject(error); } }, error => { complete(); reject(error); });
    });
  }
  #stopRuntime(): Promise<void> { return this.#runtimeShutdown ??= Promise.resolve().then(() => this.shutdown()); }
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
      const storage = packet.bytes.borrow();
      if (!storage.byteLength || storage.buffer.byteLength > bytes) throw new EngineError('OWNERSHIP_VIOLATION', 'Codec input lease must account for its entire nonempty backing store');
      if (this.#codecConfigurationEpoch !== null && this.#codecConfigurationEpoch !== packet.codecConfigEpoch) throw new EngineError('UNSUPPORTED_PROFILE', 'Codec configuration changed without an explicit decoder reset');
      if (bytes > 32 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'Codec packet exceeds 32 MiB');
      // An oversized ordinary packet gets one exclusive slot; never permanent temporary-backpressure.
      if (this.#inputItems >= 8 || (this.#inputItems > 0 && this.#inputBytes + bytes > this.#maxInputBytes)) return { status: 'backpressure', reason: 'bytes' };
      const owned = packet.bytes.move(), accepted = { ...packet, bytes: owned }; this.#inputBytes += bytes; this.#inputItems++;
      this.#codecConfigurationEpoch = packet.codecConfigEpoch;
      let resolve!: () => void, reject!: (error: unknown) => void, settled = false;
      const inputConsumed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      let unsubscribe = () => {}, cancelTimer = () => {};
      const release = () => { if (settled) return; settled = true; try { owned.release(); } finally { this.#inputBytes -= bytes; this.#inputItems--; unsubscribe(); cancelTimer(); this.#inputs.delete(inputConsumed); this.changed(); } };
      const consumed = () => { if (!settled) { this.#checkCurrent(operation); release(); resolve(); } };
      this.#inputs.set(inputConsumed, reject);
      unsubscribe = operation.cancellation.subscribe(reason => { if (!settled) this.fail(reason); });
      cancelTimer = browserScheduler.at(operation.deadlineMs, () => { if (!settled) this.fail(new EngineError('DEADLINE_EXCEEDED', 'Accepted codec input deadline elapsed')); });
      const job = async () => {
        try { this.ensureActive(); checkOperation(operation, browserScheduler); if (!sameEpoch(this.stamp, packet.stamp)) throw new EngineError('STALE_EPOCH', 'Accepted packet belongs to the previous epoch'); await this.decode(accepted, consumed); consumed(); }
        catch (error) { try { release(); } finally { reject(error); this.fail(error); } }
      };
      this.#chain = this.#chain.then(job, job); inputConsumed.catch(() => {});
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
    try {
      this.ensureActive();
      if (bytes > reservation.bytes) throw new EngineError('ITEM_TOO_LARGE', 'Decoded payload exceeds its pre-reserved output storage');
      if (!sameEpoch(this.stamp, output.stamp)) return;
      const payload = OwnedLease.adopt(reservation, value, () => this.changed());
      this.#output.push({ ...output, payload }); this.changed();
    } finally { reservation.release(); }
  }
  async readOutput(operation: OperationContext): Promise<OwnedOutput<Payload> | null> {
    this.#checkReady(operation);
    if (this.#readPending) throw new EngineError('BACKPRESSURE', 'Decoder permits only one output consumer');
    this.#readPending = true;
    try { for (;;) { this.ensureActive(); checkOperation(operation, browserScheduler); if (!sameEpoch(this.stamp, operation.stamp)) throw new EngineError('STALE_EPOCH', 'Decoder epoch changed during read'); const output = this.#output.shift(); if (output) { this.changed(); return output; } if (this.#eos) return null; await this.#wait(operation); } }
    finally { this.#readPending = false; }
  }
  async drain(operation: OperationContext): Promise<void> { this.#checkReady(operation); await this.#observe(Promise.all(this.#inputs.keys()).then(() => {}), operation); }
  async flushEndOfStream(operation: OperationContext): Promise<void> {
    this.#checkReady(operation); if (this.#eos) return;
    if (!this.#flushing) {
      const work = this.#chain.then(async () => { this.#checkCurrent(operation); await this.flush(); this.#checkCurrent(operation); this.#eos = true; this.changed(); });
      this.#flushing = work; this.#chain = work.catch(error => { this.fail(error); });
      await this.#observe(work, operation, reason => { if (sameEpoch(this.stamp, operation.stamp)) this.fail(reason); });
    } else {
      // A second observer has its own deadline, without restarting or
      // cancelling the primary caller's EOS transaction.
      await this.#observe(this.#flushing, operation);
    }
  }
  async reset(next: SessionStamp, operation: OperationContext): Promise<void> {
    checkOperation(operation, browserScheduler); if (this.terminal) throw new EngineError('DISPOSED', 'Disposed decoder cannot reset');
    if (!sameEpoch(next, operation.stamp) || next.sessionId !== this.stamp.sessionId || next.generation <= this.stamp.generation) throw new EngineError('STALE_EPOCH', 'Decoder reset needs a new epoch in the same session');
    if (this.#resetting) throw new EngineError('BACKPRESSURE', 'Decoder epoch is already resetting');
    this.stamp = next; this.#failure = null; this.fail(new EngineError('STALE_EPOCH', 'Decoder resetting'));
    for (const output of this.#output) output.payload.release(); this.#output = [];
    const transition = (async () => {
      try {
        try { await this.#stopRuntime(); } finally { await this.#chain; }
        checkOperation(operation, browserScheduler);
        if (this.terminal) throw new EngineError('DISPOSED', 'Decoder disposed during reset');
        this.#failure = null; this.#eos = false; this.#flushing = null; this.#runtimeShutdown = null; this.#codecConfigurationEpoch = null;
        await this.reopen(); this.#checkCurrent(operation);
      } catch (error) { this.#failure = null; this.fail(error); await this.#stopRuntime().catch(() => {}); throw error; }
      finally { this.#resetting = null; this.changed(); }
    })();
    this.#resetting = transition;
    await this.#observe(transition, operation, reason => { this.#failure = null; this.fail(reason); });
  }
  dispose(): Promise<void> {
    if (this.#closing) return this.#closing; this.terminal = true; this.#failure = null; this.fail(new EngineError('DISPOSED', 'Decoder disposed'));
    for (const output of this.#output) output.payload.release(); this.#output = [];
    this.#closing = (async () => { try { await this.#resetting?.catch(() => {}); await this.#stopRuntime(); } finally { await this.#chain; this.changed(); } })();
    return this.#closing;
  }
  snapshot() { return { inputBytes: this.#inputBytes, inputItems: this.#inputItems, output: this.#ledger.snapshot(), queuedOutputs: this.#output.length, eos: this.#eos, failure: this.#failure?.code ?? null }; }
}
