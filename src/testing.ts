import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, onTestFinished, vi } from 'vitest';

export const testRepositoryOwner = 'amazeelabs';
export const testRepositoryName = 'publisher-action';
export const testRepository = `${testRepositoryOwner}/${testRepositoryName}`;
export const testRunId = 42;
export const testWorkflowRunUrl = `https://github.com/${testRepository}/actions/runs/${testRunId}`;
const githubApiOrigin = 'https://api.github.com';

type ActionInputs = {
  success_env_var_name: string;
  cache_paths: string;
  cache_key: string;
  github_token: string;
};

type SetupOptions = {
  inputs?: Partial<ActionInputs>;
  env?: Record<string, string | undefined>;
} & (
  | { publisherPayload: unknown; event?: never }
  | { event: unknown; publisherPayload?: never }
);

type ActionEnvironment = {
  exportedVariables: () => Record<string, string>;
  output: () => string;
};

const defaultInputs: ActionInputs = {
  success_env_var_name: 'BUILD_IS_SUCCESSFUL',
  cache_paths: '',
  cache_key: '',
  github_token: 'test-token',
};

/**
 * The suite also runs inside GitHub Actions, where the real values of these
 * leak into the process environment. Clearing the whole namespace keeps the
 * tests deterministic without having to track what a runner sets.
 */
const runnerVariablePattern = /^(ACTIONS|GITHUB|INPUT|RUNNER)_/;

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-action-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Reverses the multiline format `@actions/core` writes to `$GITHUB_ENV`:
 * `NAME<<delimiter`, the value, then the delimiter again.
 */
function parseEnvironmentFile(contents: string): Record<string, string> {
  const variables: Record<string, string> = {};
  const lines = contents.split(EOL);
  let index = 0;
  while (index < lines.length) {
    const heading = lines[index].match(/^([^<]+)<<(.+)$/);
    if (!heading) {
      index += 1;
      continue;
    }
    const [, name, delimiter] = heading;
    const value: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== delimiter) {
      value.push(lines[index]);
      index += 1;
    }
    variables[name] = value.join(EOL);
    index += 1;
  }
  return variables;
}

export class ProcessExited extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * The exit code is what GitHub reads to mark the job red, so asserting the
 * failure without it would let a green build through.
 */
export async function expectFailedRun(run: Promise<unknown>): Promise<void> {
  await expect(run).rejects.toBeInstanceOf(ProcessExited);
  await expect(run).rejects.toMatchObject({ code: 1 });
}

/**
 * Puts the process into the state a GitHub Actions runner would create, so the
 * action modules can be imported and observed without stubbing our own code.
 */
export function setupAction(options: SetupOptions): ActionEnvironment {
  const environmentBefore = new Set(Object.keys(process.env));
  const directory = createTemporaryDirectory();
  const eventPath = join(directory, 'event.json');
  const environmentFilePath = join(directory, 'environment');

  const event =
    options.event ??
    ({
      inputs: { publisher_payload: JSON.stringify(options.publisherPayload) },
    } as unknown);
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(environmentFilePath, '');

  for (const name of Object.keys(process.env)) {
    if (runnerVariablePattern.test(name)) {
      vi.stubEnv(name, undefined);
    }
  }

  vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
  vi.stubEnv('GITHUB_ENV', environmentFilePath);
  vi.stubEnv('GITHUB_REPOSITORY', testRepository);
  vi.stubEnv('GITHUB_RUN_ID', String(testRunId));
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');

  const inputs = { ...defaultInputs, ...options.inputs };
  for (const [name, value] of Object.entries(inputs)) {
    vi.stubEnv(`INPUT_${name.toUpperCase()}`, value);
  }

  for (const [name, value] of Object.entries(options.env ?? {})) {
    vi.stubEnv(name, value);
  }

  const written: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

  // `fail()` ends the process. Turning that into an exception keeps a runaway
  // failure inside the test instead of killing the worker.
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ProcessExited(typeof code === 'number' ? code : undefined);
  });

  onTestFinished(() => {
    stdout.mockRestore();
    exit.mockRestore();
    vi.unstubAllEnvs();
    // `core.exportVariable` writes straight to `process.env`, so Vitest cannot
    // roll it back.
    for (const name of Object.keys(process.env)) {
      if (!environmentBefore.has(name)) {
        delete process.env[name];
      }
    }
    vi.resetModules();
  });
  vi.resetModules();

  return {
    exportedVariables: () =>
      parseEnvironmentFile(readFileSync(environmentFilePath, 'utf8')),
    output: () => written.join(''),
  };
}

export type ReceivedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

export type StubResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type StubServer = {
  url: string;
  requests: ReceivedRequest[];
};

export async function startStubServer(
  respond: (request: ReceivedRequest) => StubResponse | Promise<StubResponse>,
): Promise<StubServer> {
  const requests: ReceivedRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: ReceivedRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      void (async () => {
        try {
          const response = await respond(request);
          outgoing.writeHead(response.status ?? 200, {
            'content-type': 'application/json',
            ...response.headers,
          });
          outgoing.end(
            response.body === undefined ? '' : JSON.stringify(response.body),
          );
        } catch {
          outgoing.writeHead(500);
          outgoing.end();
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

/**
 * Octokit is constructed without a `baseUrl`, so the only seam is `fetch`.
 * Rewriting the origin keeps the whole Octokit request pipeline under test.
 */
export function routeGithubApiTo(server: StubServer): void {
  const actualFetch = globalThis.fetch;
  const stubbedFetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.origin !== githubApiOrigin) {
      return actualFetch(input, init);
    }
    return actualFetch(`${server.url}${url.pathname}${url.search}`, init);
  };
  vi.stubGlobal('fetch', stubbedFetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}
