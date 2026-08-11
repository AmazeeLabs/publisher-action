import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  expectFailedRun,
  routeGithubApiTo,
  setupAction,
  startStubServer,
  type StubServer,
  testWorkflowRunUrl,
} from './testing.js';

const { saveCache } = vi.hoisted(() => ({ saveCache: vi.fn() }));

vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache,
}));

const successEnvVarName = 'BUILD_IS_SUCCESSFUL';

const cacheInputs = {
  cache_key: 'fe-build-cache-dev',
  cache_paths: 'apps/website/.cache\napps/website/public',
};

async function runPost() {
  await import('./post.js');
}

async function setupPublisherAndApi(): Promise<{
  publisher: StubServer;
  api: StubServer;
}> {
  const publisher = await startStubServer(() => ({ status: 200 }));
  const api = await startStubServer((request) =>
    request.method === 'GET'
      ? {
          body: {
            total_count: 1,
            actions_caches: [
              { id: 1, key: 'fe-build-cache-dev-20240101_000000' },
            ],
          },
        }
      : { status: 200, body: {} },
  );
  routeGithubApiTo(api);
  return { publisher, api };
}

beforeEach(() => {
  saveCache.mockReset().mockResolvedValue(1);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-05-06T07:08:09.123Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('build outcome', () => {
  it('reports success when the success variable is set', async () => {
    const { publisher } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
      },
      env: { [successEnvVarName]: '1' },
    });

    await runPost();

    expect(JSON.parse(publisher.requests[0].body)).toEqual({
      status: 'success',
      workflowRunUrl: testWorkflowRunUrl,
    });
  });

  // The check is presence, not truthiness, so `echo "VAR=" >> $GITHUB_ENV`
  // counts as a success.
  it('reports success when the success variable is set but empty', async () => {
    const { publisher } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
      },
      env: { [successEnvVarName]: '' },
    });

    await runPost();

    expect(JSON.parse(publisher.requests[0].body)).toMatchObject({
      status: 'success',
    });
  });

  it('reports failure when the success variable is missing', async () => {
    const { publisher, api } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
      },
      inputs: cacheInputs,
      env: { [successEnvVarName]: undefined },
    });

    await runPost();

    // Deleting the previous caches after a failed build would leave the next
    // run with nothing to restore.
    expect(api.requests).toEqual([]);
    expect(saveCache).not.toHaveBeenCalled();
    expect(JSON.parse(publisher.requests[0].body)).toEqual({
      status: 'failure',
      workflowRunUrl: testWorkflowRunUrl,
    });
  });
});

describe('cache save', () => {
  async function setupSuccessfulBuild() {
    const servers = await setupPublisherAndApi();
    const action = setupAction({
      publisherPayload: {
        callbackUrl: `${servers.publisher.url}/callback`,
        clearCache: false,
      },
      inputs: cacheInputs,
      env: { [successEnvVarName]: '1' },
    });
    return { ...servers, action };
  }

  it('replaces the previous caches with a timestamped one', async () => {
    const { api, action } = await setupSuccessfulBuild();

    await runPost();

    expect(api.requests.map((request) => request.method)).toEqual([
      'GET',
      'DELETE',
    ]);
    expect(saveCache).toHaveBeenCalledWith(
      ['apps/website/.cache', 'apps/website/public'],
      'fe-build-cache-dev-20240506_070809',
    );
    expect(action.output()).toContain(
      'Cache saved. Key: fe-build-cache-dev-20240506_070809, ID: 1',
    );
  });

  it('skips the save when no cache is configured', async () => {
    const { publisher } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
      },
      env: { [successEnvVarName]: '1' },
    });

    await runPost();

    expect(saveCache).not.toHaveBeenCalled();
  });

  it('fails the run when the cache service reports nothing saved', async () => {
    const { publisher, action } = await setupSuccessfulBuild();
    saveCache.mockResolvedValue(0);

    await expectFailedRun(runPost());

    expect(action.output()).toContain('::error::Cache not saved');
    expect(JSON.parse(publisher.requests[0].body)).toMatchObject({
      status: 'failure',
    });
  });

  it('fails the run when saving the cache throws', async () => {
    const { publisher, action } = await setupSuccessfulBuild();
    saveCache.mockRejectedValue(new Error('quota exceeded'));

    await expectFailedRun(runPost());

    expect(action.output()).toContain(
      '::error::Failed to save cache: Error: quota exceeded',
    );
    expect(JSON.parse(publisher.requests[0].body)).toMatchObject({
      status: 'failure',
    });
  });
});
