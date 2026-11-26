import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { evidence: { type: 'string', default: '.local/device-lab' },
  baseline: { type: 'string' }, candidate: { type: 'string' }, 'prefetch-ab': { type: 'boolean' }, out: { type: 'string' } } });
const sameBuild = values['prefetch-ab'] === true;
if (!values.baseline || !values.candidate || sameBuild !== (values.baseline === values.candidate)) throw Error('Provide two exact build IDs, or use the same ID with --prefetch-ab');
const runs = [];
for (const file of (await readdir(values.evidence)).sort()) {
  if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
  const run = JSON.parse(await readFile(path.join(values.evidence, file), 'utf8'));
  if (run.scenario === 'timing' && [values.baseline, values.candidate].includes(run.build?.id)) runs.push(run);
}
const median = values => {
  const sorted = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = run => {
  const eos = run.result?.stages?.firstEos, diag = eos?.diagnostics, timing = diag?.timings;
  return { id: run.id, state: run.state, reason: run.reason ?? null, readyMs: run.result?.stages?.readyMs ?? null,
    playMs: run.result?.stages?.playMs ?? null, videoInputP95Ms: timing?.videoInputConsumed?.p95UpperMs ?? null,
    videoOutputWaitP95Ms: timing?.videoOutputWait?.p95UpperMs ?? null,
    conversionP95Ms: timing?.colorConversion?.p95UpperMs ?? null, workerConversionP95Ms: timing?.workerColorConversion?.p95UpperMs ?? null,
    canvasUploadP95Ms: timing?.canvasUpload?.p95UpperMs ?? null,
    combinedLatenessP95Ms: timing?.combinedSubmissionLateness?.p95UpperMs ?? null,
    late: diag?.lateVideoSubmissions ?? null, submitted: diag?.submittedVideoFrames ?? null, underruns: diag?.audio?.underruns ?? null };
};
const identity = run => [run.fixture.sha256, run.device?.name, run.device?.platform, run.transport, run.av1, run.foldDown, run.fixture.quality,
  run.result?.environment?.userAgent, run.result?.environment?.isolated, run.result?.environment?.devicePixelRatio,
  run.result?.stages?.firstEos?.diagnostics?.videoDecoder?.environment?.sha256 ?? run.result?.stages?.firstEos?.diagnostics?.videoDecoder?.environment?.wasmSha256,
  run.result?.stages?.firstEos?.transforms];
const groups = new Map();
const missingPair = [];
for (const r of runs) {
  if (!r.pair) { missingPair.push(summary(r)); continue; }
  if (!groups.has(r.pair)) groups.set(r.pair, []);
  groups.get(r.pair).push(r);
}
const pairs = [];
for (const [id, trial] of groups) {
  const baseline = trial.filter(r => r.build.id === values.baseline && (!sameBuild || !r.prefetchCanvas)),
    candidate = trial.filter(r => r.build.id === values.candidate && (!sameBuild || r.prefetchCanvas));
  const [a] = baseline, [b] = candidate;
  const reason = baseline.length !== 1 || candidate.length !== 1 ? 'Each label needs exactly one baseline and one candidate'
    : a.state !== 'passed' || b.state !== 'passed' ? 'One or both attempts did not finish successfully'
      : JSON.stringify(identity(a)) !== JSON.stringify(identity(b)) ? 'Fixture, device, decoder or output settings changed'
        : !a.result?.rafIntervals?.length || !b.result?.rafIntervals?.length ? 'Foreground cadence control missing' : null;
  pairs.push({ id, comparable: reason === null, reason, attempts: trial.map(summary),
    order: a && b ? (a.assignedAt < b.assignedAt ? 'baseline-first' : 'candidate-first') : null,
    baseline: a ? summary(a) : null, candidate: b ? summary(b) : null });
}
const usable = pairs.filter(p => p.comparable);
const metrics = Object.fromEntries(['readyMs', 'playMs', 'videoInputP95Ms', 'videoOutputWaitP95Ms',
  'conversionP95Ms', 'workerConversionP95Ms', 'canvasUploadP95Ms', 'combinedLatenessP95Ms', 'late', 'submitted', 'underruns'].map(name => [name, {
  baselineMedian: median(usable.map(p => p.baseline[name])), candidateMedian: median(usable.map(p => p.candidate[name])),
  medianPairedDelta: median(usable.map(p => p.baseline[name] === null || p.candidate[name] === null ? null : p.candidate[name] - p.baseline[name])),
}]));
const comparability = usable.length >= 3 && new Set(usable.map(p => p.order)).size === 2 && usable.length === pairs.length && missingPair.length === 0;
const report = { schema: 'ubve-device-lab-comparison-v1', evidenceClass: 'paired-browser-software-screening',
  baseline: values.baseline, candidate: values.candidate, hypothesis: sameBuild ? 'inline-to-one-frame-worker' : 'build-change',
  comparable: comparability, eligiblePairs: usable.length, metrics, pairs, missingPair,
  qualification: 'NOT_QUALIFIED', physicalOutput: null };
const output = JSON.stringify(report, null, 2) + '\n';
if (values.out) await writeFile(values.out, output, { flag: 'wx' });
else process.stdout.write(output);
if (!comparability) process.exitCode = 1;
