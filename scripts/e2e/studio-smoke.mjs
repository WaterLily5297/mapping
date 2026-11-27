/**
 * Browser smoke test of the Generate screen (not run in CI: needs Chromium + Playwright).
 *
 *   node dist/cli.mjs editor --port 4190 --no-open &
 *   node scripts/e2e/studio-smoke.mjs [http://127.0.0.1:4190] [--shots DIR]
 *
 * Makes a 40-second click-track WAV, loads it, generates 7K Jumpstream at 4 stars, builds a
 * full spread, downloads the mapset and opens the chart in the editor. Fails on any page error.
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:4190';
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;

function wav(bpm = 170, seconds = 40, sr = 22050) {
  const n = Math.floor(seconds * sr);
  const pcm = new Int16Array(n);
  const beat = 60 / bpm;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b * beat < seconds; b++) {
    for (const [f, kind] of [[0, 'kick'], [0.25, 'hat'], [0.5, 'snare'], [0.75, 'hat']]) {
      const s0 = Math.floor((b + f) * beat * sr);
      for (let i = 0; i < sr * 0.2 && s0 + i < n; i++) {
        const t = i / sr;
        const v = kind === 'kick' ? Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 20) * 0.9
          : kind === 'snare' ? noise() * Math.exp(-t * 25) * (b % 2 ? 0.6 : 0.3) : noise() * Math.exp(-t * 90) * 0.25;
        pcm[s0 + i] = Math.max(-32767, Math.min(32767, pcm[s0 + i] + v * 20000));
      }
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return buf;
}

const dir = mkdtempSync(join(tmpdir(), 'maniamap-e2e-'));
const song = join(dir, 'maniamap demo - click track.wav');
writeFileSync(song, wav());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const step = (s) => console.log(`- ${s}`);

await page.goto(`${url}/#generate`);
await page.setInputFiles('#st-file', song);
await page.waitForFunction(() => !document.getElementById('st-generate').disabled, null, { timeout: 60000 });
step(`song analysed: ${await page.inputValue('#st-bpm')} BPM`);
// the AI model is the default engine when installed (minutes per song on a CPU); this smoke test
// uses the instant quick-rules engine unless --ai is given
await page.waitForFunction(() => document.getElementById('st-engine-state').textContent.length > 0);
step(`engine: ${await page.textContent('#st-engine-state')}, default ${await page.textContent('#st-engine button.on')}`);
if (!process.argv.includes('--ai')) await page.click('#st-engine button[data-engine="builtin"]');
await page.click('#st-keys .keychip:has-text("7K")');
await page.fill('#st-stars', '4');
await page.dispatchEvent('#st-stars', 'input');
await page.click('.stylecard[data-style="auto"]');
await page.click('#st-generate');
await page.waitForSelector('#st-result:not([hidden])', { timeout: process.argv.includes('--ai') ? 1800000 : 120000 });
await page.waitForFunction(() => document.getElementById('st-busy').hidden);
const stars = Number((await page.textContent('#r-star')).replace(/[^\d.]/g, ''));
step(`generated ${await page.textContent('#r-version')}: ${stars} stars by ${await page.textContent('#r-engine')}`);
if (Math.abs(stars - 4) > 0.3) throw new Error(`star target missed: ${stars}`);
if (shots) {
  await page.waitForTimeout(600);
  await page.evaluate(() => { document.querySelector('.st-left').scrollTop = 0; });
  await page.click('#r-play');
  await page.waitForTimeout(3000);
  await page.click('#r-play');
  await page.screenshot({ path: join(shots, 'generate.png') });
}
await page.click('#ms-spread');
await page.waitForFunction(() => document.getElementById('st-busy').hidden && document.querySelectorAll('.ms-item').length >= 3, null, { timeout: 180000 });
step(`spread: ${await page.locator('.ms-item').count()} difficulties`);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ms-download')]);
step(`downloaded ${dl.suggestedFilename()}`);
await page.click('#r-editor');
await page.waitForSelector('#view-editor:not([hidden])');
step(await page.textContent('#status'));
if (shots) await page.screenshot({ path: join(shots, 'editor.png') });
await browser.close();
if (errors.length) { console.error('page errors:', errors); process.exit(1); }
console.log('ok');
