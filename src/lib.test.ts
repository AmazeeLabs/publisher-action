import { describe, expect, it } from 'vitest';

import {
  expectFailedRun,
  type ReceivedRequest,
  routeGithubApiTo,
  setupAction,
  startStubServer,
  type StubResponse,
  testRepositoryName,
  testRepositoryOwner,
  testWorkflowRunUrl,
} from './testing.js';

async function loadLib() {
  return await import('./lib.js');
}

function cacheListResponse(keys: string[]) {
  return {
    total_count: keys.length,
    actions_caches: keys.map((key, index) => ({ id: index + 1, key })),
  };
}

describe('config', () => {
  it('reads the payload from the workflow event and the action inputs', async () => {
    setupAction({
      publisherPayload: {
        callbackUrl: 'https://publisher.example/callback',
        clearCache: true,
        environmentVariables: { FOO: 'bar' },
      },
      inputs: {
        success_env_var_name: 'BUILD_OK',
        github_token: 'secret-token',
      },
    });

    const { config } = await loadLib();

    expect(config.successEnvVarName).toBe('BUILD_OK');
    expect(config.githubToken).toBe('secret-token');
    expect(config.cache).toBeNull();
    expect(config.publisherPayload).toEqual({
      callbackUrl: 'https://publisher.example/callback',
      clearCache: true,
      environmentVariables: { FOO: 'bar' },
    });
  });

  it('splits cache paths into a list, ignoring blank lines and padding', async () => {
    setupAction({
      publisherPayload: {
        callbackUrl: 'https://publisher.example/callback',
        clearCache: false,
      },
      inputs: {
        cache_key: 'fe-build-cache-dev',
        cache_paths: '  apps/website/.cache  \n\n\tapps/website/public\n',
      },
    });

    const { config } = await loadLib();

    expect(config.cache).toEqual({
      key: 'fe-build-cache-dev',
      paths: ['apps/website/.cache', 'apps/website/public'],
    });
  });

  it.each([
    { case: 'paths without a key', inputs: { cache_paths: 'apps/public' } },
    { case: 'a key without paths', inputs: { cache_key: 'fe-build-cache' } },
    {
      case: 'blank paths only',
      inputs: { cache_key: 'k', cache_paths: ' \n' },
    },
  ])('ignores the cache when given $case', async ({ inputs }) => {
    setupAction({
      publisherPayload: {
        callbackUrl: 'https://publisher.example/callback',
        clearCache: false,
      },
      inputs,
    });

    const { config } = await loadLib();

    expect(config.cache).toBeNull();
  });

  it.each([
    {
      case: 'the event carries no inputs',
      event: {},
      message: 'Missing "publisher_payload" input',
    },
    {
      case: 'the payload input is empty',
      event: { inputs: { publisher_payload: '   ' } },
      message: 'Missing "publisher_payload" input',
    },
    {
      case: 'the payload is not valid JSON',
      event: { inputs: { publisher_payload: '{not json' } },
      message: 'Failed to parse "publisher_payload" input',
    },
    {
      case: 'the payload does not match the schema',
      event: { inputs: { publisher_payload: '{"callbackUrl":"x"}' } },
      message: 'clearCache',
    },
  ])('fails when $case', async ({ event, message }) => {
    const action = setupAction({ event });

    await expectFailedRun(loadLib());
    expect(action.output()).toContain(message);
  });

  it('fails when an input is invalid, without notifying Publisher', async () => {
    const server = await startStubServer(() => ({ status: 200 }));
    setupAction({
      publisherPayload: {
        callbackUrl: `${server.url}/callback`,
        clearCache: false,
      },
      inputs: { success_env_var_name: '2-invalid-name' },
    });

    await expectFailedRun(loadLib());
    expect(server.requests).toEqual([]);
  });
});

describe('notifyPublisher', () => {
  async function loadLibWithCallback(response: () => { status?: number }) {
    const server = await startStubServer(response);
    setupAction({
      publisherPayload: {
        callbackUrl: `${server.url}/callback`,
        clearCache: false,
      },
    });
    return { server, ...(await loadLib()) };
  }

  it('posts the status and the workflow run url as JSON', async () => {
    const { server, notifyPublisher } = await loadLibWithCallback(() => ({
      status: 200,
    }));

    await notifyPublisher({ status: 'started' });

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/callback');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({
      status: 'started',
      workflowRunUrl: testWorkflowRunUrl,
    });
  });

  it('warns instead of throwing when Publisher rejects the notification', async () => {
    const action = setupAction({
      publisherPayload: {
        callbackUrl: (await startStubServer(() => ({ status: 503 }))).url,
        clearCache: false,
      },
    });
    const { notifyPublisher } = await loadLib();

    await expect(
      notifyPublisher({ status: 'success' }),
    ).resolves.toBeUndefined();
    expect(action.output()).toContain('::warning::Failed to notify Publisher');
    expect(action.output()).toContain('503');
  });

  it('warns instead of throwing when Publisher is unreachable', async () => {
    const action = setupAction({
      publisherPayload: {
        callbackUrl: 'http://127.0.0.1:1/callback',
        clearCache: false,
      },
    });
    const { notifyPublisher } = await loadLib();

    await expect(
      notifyPublisher({ status: 'failure' }),
    ).resolves.toBeUndefined();
    expect(action.output()).toContain('::warning::Failed to notify Publisher');
  });
});

describe('fail', () => {
  it('reports a failure to Publisher before ending the run', async () => {
    const server = await startStubServer(() => ({ status: 200 }));
    const action = setupAction({
      publisherPayload: {
        callbackUrl: `${server.url}/callback`,
        clearCache: false,
      },
    });
    const { fail } = await loadLib();

    await expectFailedRun(fail('something broke'));

    expect(JSON.parse(server.requests[0].body)).toEqual({
      status: 'failure',
      workflowRunUrl: testWorkflowRunUrl,
    });
    expect(action.output()).toContain('::error::something broke');
  });
});

describe('clearCache', () => {
  async function setupCacheApi(
    respond: (request: ReceivedRequest) => StubResponse,
  ) {
    const publisher = await startStubServer(() => ({ status: 200 }));
    const api = await startStubServer(respond);
    routeGithubApiTo(api);
    const action = setupAction({
      publisherPayload: {
        callbackUrl: `${publisher.url}/callback`,
        clearCache: true,
      },
      inputs: {
        cache_key: 'fe-build-cache-dev',
        cache_paths: 'apps/website/public',
      },
    });
    return { publisher, api, action };
  }

  it('does nothing when no cache is configured', async () => {
    const api = await startStubServer(() => ({ status: 200 }));
    routeGithubApiTo(api);
    setupAction({
      publisherPayload: {
        callbackUrl: 'https://publisher.example/callback',
        clearCache: true,
      },
    });

    const { clearCache } = await loadLib();
    await clearCache();

    expect(api.requests).toEqual([]);
  });

  it('deletes only the caches that belong to the configured key', async () => {
    const { api } = await setupCacheApi((request) =>
      request.method === 'GET'
        ? {
            body: cacheListResponse([
              'fe-build-cache-dev-20240101_000000',
              'fe-build-cache-dev-20240102_000000',
              'fe-build-cache-prod-20240101_000000',
              'fe-build-cache-dev',
            ]),
          }
        : { status: 200, body: {} },
    );

    const { clearCache } = await loadLib();
    await clearCache();

    const deleted = api.requests
      .filter((request) => request.method === 'DELETE')
      .map((request) =>
        new URL(request.path, 'http://x').searchParams.get('key'),
      )
      .sort();
    expect(deleted).toEqual([
      'fe-build-cache-dev-20240101_000000',
      'fe-build-cache-dev-20240102_000000',
    ]);
  });

  it('asks the API for the caches of the current repository', async () => {
    const { api } = await setupCacheApi(() => ({
      body: cacheListResponse([]),
    }));

    const { clearCache } = await loadLib();
    await clearCache();

    expect(api.requests[0].path).toBe(
      `/repos/${testRepositoryOwner}/${testRepositoryName}/actions/caches`,
    );
    expect(api.requests[0].headers.authorization).toBe('token test-token');
  });

  it('fails the run when deleting one of the caches is rejected', async () => {
    const { api, publisher, action } = await setupCacheApi((request) =>
      request.method === 'GET'
        ? { body: cacheListResponse(['fe-build-cache-dev-20240101_000000']) }
        : { status: 500, body: { message: 'Server Error' } },
    );

    const { clearCache } = await loadLib();
    await expectFailedRun(clearCache());

    expect(api.requests.map((request) => request.method)).toEqual([
      'GET',
      'DELETE',
    ]);
    expect(JSON.parse(publisher.requests[0].body)).toMatchObject({
      status: 'failure',
    });
    expect(action.output()).toContain('::error::Failed to delete cache');
  });

  it('fails the run when the API rejects the request', async () => {
    const { api, publisher, action } = await setupCacheApi(() => ({
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    }));

    const { clearCache } = await loadLib();
    await expectFailedRun(clearCache());

    expect(api.requests).toHaveLength(1);
    expect(JSON.parse(publisher.requests[0].body)).toMatchObject({
      status: 'failure',
    });
    expect(action.output()).toContain('::error::Failed to delete cache');
  });
});
