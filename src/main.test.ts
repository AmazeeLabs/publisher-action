import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectFailedRun, setupAction, startStubServer } from './testing.js';

const { restoreCache } = vi.hoisted(() => ({ restoreCache: vi.fn() }));

vi.mock('@actions/cache', () => ({
  restoreCache,
  saveCache: vi.fn(),
}));

const callbackUrl = 'https://publisher.example/callback';

async function runMain() {
  await import('./main.js');
}

beforeEach(() => {
  restoreCache.mockReset().mockResolvedValue(undefined);
});

describe('environment variables', () => {
  it('writes the payload variables to the workflow environment file', async () => {
    const action = setupAction({
      publisherPayload: {
        callbackUrl,
        clearCache: false,
        environmentVariables: { API_URL: 'https://api.example', STAGE: 'dev' },
      },
    });

    await runMain();

    expect(action.exportedVariables()).toEqual({
      API_URL: 'https://api.example',
      STAGE: 'dev',
    });
  });

  it('fails the run when a variable cannot be exported', async () => {
    const publisher = await startStubServer(() => ({ status: 200 }));
    const action = setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
        environmentVariables: { API_URL: 'https://api.example' },
      },
      env: { GITHUB_ENV: '/nonexistent/environment' },
    });

    await expectFailedRun(runMain());

    expect(action.output()).toContain(
      '::error::Failed to set environment variables',
    );
    expect(JSON.parse(publisher.requests[0].body)).toMatchObject({
      status: 'failure',
    });
  });

  it('writes nothing when the payload carries no variables', async () => {
    const action = setupAction({
      publisherPayload: { callbackUrl, clearCache: false },
    });

    await runMain();

    expect(action.exportedVariables()).toEqual({});
  });
});

describe('cache restore', () => {
  const cacheInputs = {
    cache_key: 'fe-build-cache-dev',
    cache_paths: 'apps/website/.cache\napps/website/public',
  };

  it('restores the most recent cache through a restore key prefix', async () => {
    const action = setupAction({
      publisherPayload: { callbackUrl, clearCache: false },
      inputs: cacheInputs,
    });
    restoreCache.mockResolvedValue('fe-build-cache-dev-20240102_000000');

    await runMain();

    expect(restoreCache).toHaveBeenCalledWith(
      ['apps/website/.cache', 'apps/website/public'],
      'fe-build-cache-dev-FAKE-KEY',
      ['fe-build-cache-dev-'],
    );
    expect(action.output()).toContain(
      'Cache restored: fe-build-cache-dev-20240102_000000',
    );
  });

  it('reports a cache miss without failing', async () => {
    const action = setupAction({
      publisherPayload: { callbackUrl, clearCache: false },
      inputs: cacheInputs,
    });

    await runMain();

    expect(action.output()).toContain('Cache not found');
  });

  it('skips the restore when the payload asks for a cache clear', async () => {
    setupAction({
      publisherPayload: { callbackUrl, clearCache: true },
      inputs: cacheInputs,
    });

    await runMain();

    expect(restoreCache).not.toHaveBeenCalled();
  });

  it('skips the restore when no cache is configured', async () => {
    setupAction({
      publisherPayload: { callbackUrl, clearCache: false },
    });

    await runMain();

    expect(restoreCache).not.toHaveBeenCalled();
  });

  it('warns and continues when the cache service is unavailable', async () => {
    const action = setupAction({
      publisherPayload: { callbackUrl, clearCache: false },
      inputs: cacheInputs,
    });
    restoreCache.mockRejectedValue(new Error('cache service unreachable'));

    await expect(runMain()).resolves.toBeUndefined();

    expect(action.output()).toContain(
      '::warning::Failed to restore cache: Error: cache service unreachable',
    );
  });
});
