import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  envVarNameSchema,
  WorkflowPublisherPayload,
  workflowPublisherPayloadSchema,
  WorkflowStatusNotification,
} from '@amazeelabs/publisher-shared';
import { Octokit } from '@octokit/rest';
import { z, ZodType } from 'zod';

import { InputKey } from './inputs.js';

type Config = {
  successEnvVarName: string;
  cache: {
    paths: string[];
    key: string;
  } | null;
  githubToken: string;
  publisherPayload: WorkflowPublisherPayload;
};

// Unfortunately, there is no easy way to get the job ID, so we link to the
// workflow run instead (not to the logs directly).
const workflowRunUrl = `${github.context.serverUrl}/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`;

const inputsSchema = z
  .object(
    {
      success_env_var_name: envVarNameSchema,
      cache_paths: z.string(),
      cache_key: z.string(),
      github_token: z.string().min(1),
    } satisfies Record<InputKey, ZodType>,
    {
      message: 'Invalid inputs',
    },
  )
  .transform((data): Omit<Config, 'publisherPayload'> => {
    const cachePaths = data.cache_paths
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean);
    return {
      successEnvVarName: data.success_env_var_name,
      cache:
        data.cache_key && cachePaths.length
          ? { paths: cachePaths, key: data.cache_key }
          : null,
      githubToken: data.github_token,
    };
  });

async function getConfig(): Promise<Config> {
  try {
    const publisherPayloadJson: unknown =
      github.context.payload.inputs?.publisher_payload;
    if (
      !publisherPayloadJson ||
      typeof publisherPayloadJson !== 'string' ||
      !publisherPayloadJson.trim()
    ) {
      throw new Error(
        'Missing "publisher_payload" input. It should be defined in the workflow file.',
      );
    }
    let publisherPayloadRaw: unknown;
    try {
      publisherPayloadRaw = JSON.parse(publisherPayloadJson);
    } catch (error) {
      throw new Error(`Failed to parse "publisher_payload" input: ${error}`, {
        cause: error,
      });
    }
    const publisherPayload =
      workflowPublisherPayloadSchema.parse(publisherPayloadRaw);

    return {
      ...inputsSchema.parse({
        success_env_var_name: core.getInput('success_env_var_name'),
        cache_key: core.getInput('cache_key'),
        cache_paths: core.getInput('cache_paths'),
        github_token: core.getInput('github_token'),
      } satisfies Record<InputKey, string>),
      publisherPayload,
    };
  } catch (error) {
    await fail(`Failed to get config: ${error}`, {
      skipNotification: true,
    });
    throw new Error('Unreachable', { cause: error });
  }
}

export const config = await getConfig();

export async function notifyPublisher(
  notification: Omit<WorkflowStatusNotification, 'workflowRunUrl'>,
): Promise<void> {
  try {
    const response = await fetch(config.publisherPayload.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...notification,
        workflowRunUrl,
      } satisfies WorkflowStatusNotification),
    });
    if (!response.ok) {
      core.warning(
        `Failed to notify Publisher: ${response.status} ${await response.text()}`,
      );
    }
  } catch (error) {
    core.warning(`Failed to notify Publisher: ${error}`);
  }
}

export async function fail(
  message: string,
  options?: { skipNotification: boolean },
): Promise<never> {
  if (!options?.skipNotification) {
    await notifyPublisher({ status: 'failure' });
  }
  core.setFailed(message);
  process.exit(1);
}

export async function clearCache(): Promise<void> {
  if (!config.cache) {
    return;
  }
  try {
    const octokit = new Octokit({ auth: config.githubToken });
    const [owner, repo] = process.env.GITHUB_REPOSITORY!.split('/');
    // FIXME: Paginate. Only the first page is listed, so a repository with many
    // caches keeps old entries and risks stale builds.
    const list = await octokit.actions.getActionsCacheList({
      owner,
      repo,
    });

    await Promise.all(
      list.data.actions_caches
        .filter(
          (cache): cache is { key: string } =>
            !!cache.key?.startsWith(`${config.cache!.key}-`),
        )
        .map((cache) => {
          core.info(`Deleting cache ${cache.key}`);
          return octokit.actions.deleteActionsCacheByKey({
            key: cache.key,
            owner,
            repo,
          });
        }),
    );
  } catch (error) {
    core.error(
      'ℹ️Tip: It can be that you need to give both "read" and "write" permissions to the GITHUB_TOKEN. The easiest way to do this is to update Actions settings of the repository.',
    );
    // It's critical to delete old caches. Otherwise, we will get stale builds.
    await fail(`Failed to delete cache: ${error}`);
  }
}
