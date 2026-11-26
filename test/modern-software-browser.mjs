import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const manifestFile = process.argv[2] ?? 'test/fixtures/modern/manifest.json';
const selected = new Set(process.argv.slice(3));
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const mediaRoot = process.env.UBVE_MODERN_MEDIA_ROOT ?? path.dirname(manifestFile);
const checkSeek = process.env.UBVE_SOFTWARE_BROWSER_SEEK === '1';
const rows = manifest.cases.filter(row => !selected.size || selected.has(row.id));
assert.ok(rows.length, 'No matching browser fixture');
const output = '.local/modern-browser';
await mkdir(output, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-') + '-' + process.pid;
const server = await createServer({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player', server: { host: '127.0.0.1', port: 0 } });
const results = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, args: ['--disable-gpu'], headless: true });
  for (const row of rows) {
    const file = path.resolve(mediaRoot, row.path), record = { id: row.id, fixtureSha256: row.sha256, status: 'FAILED' };
    results.push(record);
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    try {
      assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), row.sha256);
      const address = server.httpServer.address(), params = new URLSearchParams({
        quality: row.quality ?? 'full',
        seek: checkSeek ? '1' : '0',
      });
      await page.goto(`http://127.0.0.1:${address.port}/tests/software.html?${params}`);
      await page.locator('#fixture').setInputFiles(file);
      await page.locator('#start').click();
      await page.waitForSelector('#result[data-complete=true]', { timeout: checkSeek ? 145_000 : 85_000 });
      const receipt = JSON.parse(await page.locator('#result').textContent());
      record.receipt = receipt;
      assert.equal(receipt.outcome, 'PASSED', receipt.error);
      assert.equal(receipt.eos.snapshot.route, 'C1');
      assert.equal(receipt.cleanup, true);
      assert.equal(receipt.secure, true);
      assert.equal(receipt.isolated, false);
      if (checkSeek) assert.equal(receipt.seek, 'PASSED');
      const managed = receipt.eos.managed, expected = row.expected ?? {};
      if (expected.videoFrames != null) {
        assert.equal(managed.decodedVideoFrames, expected.videoFrames);
        assert.equal(managed.submittedVideoFrames, expected.videoFrames);
      }
      if (expected.pcmFrames != null) assert.equal(managed.audio.consumedFrames, expected.pcmFrames);
      record.status = 'PASSED';
    } catch (error) { record.error = error.message; process.exitCode = 1; }
    finally { await page.close(); }
    console.log(`${row.id} ${record.status}${record.error ? ' · ' + record.error.split('\n')[0] : ''}`);
  }
} finally {
  await browser?.close();
  await server.close();
  await writeFile(path.join(output, stamp + '.json'), JSON.stringify({ browser: browser?.version() ?? null, results }, null, 2) + '\n');
}
