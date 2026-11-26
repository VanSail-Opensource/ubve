const edges = [.125, .25, .5, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 200, 400, 1000, 5000];
type Stage = 'sourcePacketWait' | 'videoPacketQueueWait' | 'audioPacketQueueWait' | 'videoInputConsumed' | 'audioInputConsumed' |
  'videoOutputWait' | 'audioOutputWait' | 'colorConversion' | 'workerColorConversion' | 'canvasUpload' | 'subtitleRender' | 'combinedSubmissionLateness';
type Timing = { n: number; totalMs: number; maxMs: number; histogram: number[] };

/** Optional bounded browser timing. Ordinal bins do not retain frame data,
 * affect admission, or turn software observations into physical timing. */
export class PlaybackTrace {
  #stages = new Map<Stage, Timing>();
  add(stage: Stage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let row = this.#stages.get(stage);
    if (!row) {
      row = { n: 0, totalMs: 0, maxMs: 0, histogram: Array<number>(edges.length + 1).fill(0) };
      this.#stages.set(stage, row);
    }
    const index = edges.findIndex(edge => ms <= edge), bucket = index < 0 ? edges.length : index;
    row.histogram[bucket] = row.histogram[bucket]! + 1;
    row.n++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
  }
  summary() {
    return Object.fromEntries([...this.#stages].map(([stage, row]) => {
      let seen = 0;
      const tail = row.histogram.findIndex(count => (seen += count) >= Math.ceil(row.n * .95));
      return [stage, { n: row.n, totalMs: row.totalMs, maxMs: row.maxMs, p95UpperMs: edges[tail] ?? null,
        bucketsMs: [...edges, null], histogram: [...row.histogram] }];
    }));
  }
}
