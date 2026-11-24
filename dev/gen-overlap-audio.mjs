// Generates dev/audio/overlap/<scenario>_<n>.wav from dev/overlap.json with macOS `say`.
// Usage: node dev/gen-overlap-audio.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const out = join(dir, 'audio', 'overlap');
mkdirSync(out, { recursive: true });

const VOICES = { ja: 'Kyoko', en: 'Samantha' };
// "second-ja": another Japanese voice than Kyoko. Looked up because voice names are localized
// ("Eddy (日本語（日本）)" on a Japanese macOS).
const secondJa = execFileSync('say', ['-v', '?'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.match(/^(.+?)\s+ja_JP\s/)?.[1]?.trim())
  .find((name) => name && name !== VOICES.ja);
const voiceOf = (clip) => (clip.voice === 'second-ja' ? secondJa : (clip.voice ?? VOICES[clip.lang]));
const scenarios = JSON.parse(readFileSync(join(dir, 'overlap.json'), 'utf8'));

for (const s of scenarios) {
  s.clips.forEach((clip, i) => {
    const name = `${s.id}_${i + 1}`;
    const aiff = join(out, `${name}.aiff`);
    execFileSync('say', ['-v', voiceOf(clip), '-o', aiff, clip.text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, join(out, `${name}.wav`)]);
  });
}

writeFileSync(join(out, 'done'), '');
console.log(`wrote ${scenarios.length} scenarios to ${out}`);
