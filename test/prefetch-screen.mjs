// Run this on an otherwise reserved host with a frozen build. Short software
// screening only. The fixture and the browser harness enforce decoded/submitted
// counts, exact PCM EOS, seek and cleanup on each run.
import { execFile as callback } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(callback), root = path.resolve('.local/prefetch-pairs', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid);
await mkdir(root, { recursive: true });
const rows = [];
for (const [pair, modes] of [['1', ['inline', 'worker']], ['2', ['worker', 'inline']], ['3', ['inline', 'worker']]]) {
  for (const mode of modes) {
    const dir = path.join(root, pair + '-' + mode);
    await mkdir(dir);
    const row = { pair, mode, status: 'FAILED', files: [] };
    rows.push(row);
    const env = { ...process.env, UBVE_PIPELINE_TRACE: '1', UBVE_PIPELINE_PREFETCH: mode === 'worker' ? '1' : '0', UBVE_PIPELINE_OUTPUT: dir };
    try {
      const { stdout, stderr } = await exec(process.execPath, ['test/pipeline-browser.mjs'], { env, timeout: 115_000, maxBuffer: 1024 * 1024 });
      await writeFile(path.join(dir, 'process.log'), stdout + stderr);
      row.status = 'PASSED';
    } catch (error) {
      await writeFile(path.join(dir, 'process.log'), (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message);
    }
    for (const filename of await readdir(dir)) {
      if (!filename.endsWith('.json') || filename.endsWith('-cohort.json')) continue;
      const result = JSON.parse(await readFile(path.join(dir, filename), 'utf8'));
      const state = result.stages?.find(s => s.event === 'eos')?.diagnostics?.managed, timings = state?.timings;
      row.files.push({ filename, fixture: result.fixture?.sha256, colorMs: timings?.colorConversion?.totalMs ?? null,
        canvasMs: timings?.canvasUpload?.totalMs ?? null, workerColorMs: timings?.workerColorConversion?.totalMs ?? null,
        observedLatenessP95UpperMs: timings?.combinedSubmissionLateness?.p95UpperMs ?? null,
        lateSubmissions: state?.lateVideoSubmissions ?? null, submitted: state?.submittedVideoFrames ?? null,
        underruns: state?.audio?.underruns ?? null, foreground: !!result.foregroundEvents?.length &&
          result.foregroundEvents.every(x => x.hasFocus && x.visibility === 'visible'),
        eosRaster: result.eosRasterSha256 ?? null });
    }
    console.log(`Pair ${pair} ${mode} ${row.status}`);
  }
}
let allComparable = true;
const pairs = Array.from({ length: 3 }, (_, i) => {
  const baseline = rows.find(x => x.pair === String(i + 1) && x.mode === 'inline'), candidate = rows.find(x => x.pair === String(i + 1) && x.mode === 'worker');
  const comparable = baseline.status === 'PASSED' && candidate.status === 'PASSED' && baseline.files.length === 1 && candidate.files.length === 1 &&
    baseline.files[0].fixture === candidate.files[0].fixture && Boolean(baseline.files[0].eosRaster) &&
    baseline.files[0].eosRaster === candidate.files[0].eosRaster && baseline.files[0].foreground && candidate.files[0].foreground;
  allComparable &&= comparable;
  return { pair: i + 1, comparable, baseline, candidate };
});
await writeFile(path.join(root, 'comparison.json'), JSON.stringify({ scope: 'Paired short Playwright software screening, not sustained or physical output',
  comparable: allComparable, qualification: 'NOT_QUALIFIED', pairs }, null, 2) + '\n');
console.log(root);
if (!allComparable) process.exitCode = 1;
