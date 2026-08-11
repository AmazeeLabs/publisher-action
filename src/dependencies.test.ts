import * as cache from '@actions/cache';
import { expect, it } from 'vitest';

// `@actions/cache` needs a live cache service, so the stages that use it are
// tested against a mock. This import is the only place the real module is
// loaded. It checks that the module loads, and deliberately nothing else — how
// it behaves is GitHub's business, not ours.
it('loads @actions/cache', () => {
  expect(cache.restoreCache).toBeTypeOf('function');
  expect(cache.saveCache).toBeTypeOf('function');
});
