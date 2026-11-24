import { requireCondition, type DeadlineScheduler } from '@ubve/core';

/** Deterministic unit-test clock. It makes no browser timing or CPU claim. */
export class ManualScheduler implements DeadlineScheduler {
  #now = 0;
  #nextId = 0;
  #tasks = new Map<number, { deadline: number; callback: () => void }>();
  nowMs(): number { return this.#now; }
  at(deadline: number, callback: () => void): () => void {
    requireCondition(Number.isFinite(deadline) && deadline >= this.#now, 'Invalid scheduler deadline');
    const id = ++this.#nextId;
    this.#tasks.set(id, { deadline, callback });
    return () => { this.#tasks.delete(id); };
  }
  advanceTo(now: number): void {
    requireCondition(Number.isFinite(now) && now >= this.#now, 'Manual time cannot run backwards');
    while (true) {
      const due = [...this.#tasks.entries()].filter(([, t]) => t.deadline <= now).sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0])[0];
      if (!due) break;
      this.#now = due[1].deadline;
      this.#tasks.delete(due[0]);
      due[1].callback();
    }
    this.#now = now;
  }
  pendingCount(): number { return this.#tasks.size; }
}
