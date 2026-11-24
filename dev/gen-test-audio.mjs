// Generates dev/audio/NN_<lang>.wav from dev/utterances.json with macOS `say`.
// Usage: node dev/gen-test-audio.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const out = join(dir, 'audio');
mkdirSync(out, { recursive: true });

const VOICES = { ja: 'Kyoko', en: 'Samantha' };
const utterances = JSON.parse(readFileSync(join(dir, 'utterances.json'), 'utf8'));

const files = utterances.map(({ lang, text }, i) => {
  const name = `${String(i + 1).padStart(2, '0')}_${lang}`;
  const aiff = join(out, `${name}.aiff`);
  execFileSync('say', ['-v', VOICES[lang], '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, join(out, `${name}.wav`)]);
  return `${name}.wav`;
});

writeFileSync(join(out, 'index.json'), JSON.stringify(files, null, 2));
console.log(`wrote ${files.length} files to ${out}`);
