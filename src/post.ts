import * as cache from '@actions/cache';
import * as core from '@actions/core';

import { clearCache, config, fail, notifyPublisher } from './lib.js';

const isSuccess = config.successEnvVarName in process.env;

if (isSuccess && config.cache) {
  core.info('Deleting previous caches');
  await clearCache();

  core.info('Saving cache');
  try {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '_');
    const cacheKey = `${config.cache.key}-${timestamp}`;
    const savedId = await cache.saveCache(config.cache.paths, cacheKey);
    // `saveCache` swallows most failures and returns -1 instead of throwing.
    if (savedId > 0) {
      core.info(`Cache saved. Key: ${cacheKey}, ID: ${savedId}`);
    } else {
      // While saving a cache sounds like an optional thing to do, actually it's
      // critical to do it. Otherwise, we might get stale builds. For example,
      // if there is an issue with Github not properly deleting old caches.
      await fail('Cache not saved');
    }
  } catch (error) {
    await fail(`Failed to save cache: ${error}`);
  }
}

core.info('Notifying Publisher');
await notifyPublisher({ status: isSuccess ? 'success' : 'failure' });
