import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { inputNames } from './inputs.js';

// Nothing else connects `action.yml` to the code: renaming an input there, or
// pointing a stage at a file that is not built, leaves every other test green
// and breaks the action on the runner.
const manifest = readFileSync(
  new URL('../action.yml', import.meta.url),
  'utf8',
);

describe('action.yml', () => {
  it.each(inputNames)('declares the %s input', (name) => {
    expect(manifest).toMatch(new RegExp(`^ {2}${name}:$`, 'm'));
  });

  it.each(['pre', 'main', 'post'])('points %s at a built bundle', (stage) => {
    const entry = `dist/${stage}/index.js`;
    expect(manifest).toMatch(new RegExp(`^ {2}${stage}: ${entry}$`, 'm'));
    expect(existsSync(new URL(`../${entry}`, import.meta.url))).toBe(true);
  });
});
