import { describe, expect, it } from 'vitest';

import {
  routeGithubApiTo,
  setupAction,
  startStubServer,
  type StubServer,
  testWorkflowRunUrl,
} from './testing.js';

async function runPre() {
  await import('./pre.js');
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

const cacheInputs = {
  cache_key: 'fe-build-cache-dev',
  cache_paths: 'apps/website/public',
};

describe('pre', () => {
  it('tells Publisher that the workflow started', async () => {
    const { publisher } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
      },
    });

    await runPre();

    expect(publisher.requests).toHaveLength(1);
    expect(JSON.parse(publisher.requests[0].body)).toEqual({
      status: 'started',
      workflowRunUrl: testWorkflowRunUrl,
    });
  });

  it('deletes the existing caches when the payload asks for a cache clear', async () => {
    const { publisher, api } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: true,
      },
      inputs: cacheInputs,
    });

    await runPre();

    expect(api.requests.map((request) => request.method)).toEqual([
      'GET',
      'DELETE',
    ]);
  });

  it('keeps the caches when the payload does not ask for a clear', async () => {
    const { publisher, api } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: false,
      },
      inputs: cacheInputs,
    });

    await runPre();

    expect(api.requests).toEqual([]);
  });

  it('keeps the caches when none is configured', async () => {
    const { publisher, api } = await setupPublisherAndApi();
    setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: true,
      },
    });

    await runPre();

    expect(api.requests).toEqual([]);
  });
});
