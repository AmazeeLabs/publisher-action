import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

// These modules pull in most of the bundled dependency graph. A dependency bump
// that breaks module resolution or CommonJS interop fails here rather than in a
// production workflow run.
describe('bundled dependencies', () => {
  it('loads @actions/cache and its transitive dependencies', () => {
    expect(cache.restoreCache).toBeTypeOf('function');
    expect(cache.saveCache).toBeTypeOf('function');
  });

  it('loads @actions/core', () => {
    expect(core.getInput).toBeTypeOf('function');
    expect(core.exportVariable).toBeTypeOf('function');
  });

  it('loads @actions/github', () => {
    expect(github.context).toBeTypeOf('object');
  });

  it('exposes the Octokit cache endpoints the action calls', () => {
    const octokit = new Octokit({ auth: 'token' });
    expect(octokit.actions.getActionsCacheList).toBeTypeOf('function');
    expect(octokit.actions.deleteActionsCacheByKey).toBeTypeOf('function');
  });
});
