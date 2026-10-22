import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function publicationUrl(packageName, version, expectedGitHead) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName ?? '') ||
      !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
      !/^[a-f0-9]{40}$/.test(expectedGitHead ?? '')) {
    throw failure('NPM_PUBLICATION_INPUT_INVALID', 'An exact package, stable version and Git commit are required.');
  }
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
}

function fetchMetadata(url, fetchImpl, timeoutMs) {
  return fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.ceil(timeoutMs)))),
  });
}

async function readMetadata(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('NPM_PUBLICATION_INVALID', 'Public npm metadata is empty.');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 262_144) {
        await reader.cancel();
        throw failure('NPM_PUBLICATION_INVALID', 'Public npm metadata exceeds the bounded read limit.');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

async function verifyIdentity(response, packageName, version, expectedGitHead) {
  let metadata;
  try {
    metadata = await readMetadata(response);
  } catch {
    throw failure('NPM_PUBLICATION_INVALID', 'Public npm metadata is invalid or exceeds the bounded read limit.');
  }
  if (metadata?.name !== packageName || metadata?.version !== version ||
      metadata?.gitHead !== expectedGitHead) {
    throw failure('NPM_PUBLICATION_IDENTITY_MISMATCH',
      'Public npm name, version or gitHead does not match the immutable release commit.');
  }
}

/** On a rerun, an unreadable version may already have been accepted. Never republish it. */
export async function checkNpmPublicationBeforePublish({ runAttempt, ...options }) {
  const { packageName, version, expectedGitHead, fetchImpl = globalThis.fetch } = options;
  const url = publicationUrl(packageName, version, expectedGitHead);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw failure('NPM_PUBLICATION_INPUT_INVALID', 'The trusted workflow run attempt is required.');
  }
  if (runAttempt > 1) {
    return { published: true, ...await waitForNpmPublication(options) };
  }
  let response;
  try {
    response = await fetchMetadata(url, fetchImpl, 15_000);
  } catch {
    throw failure('NPM_PUBLICATION_PREFLIGHT_UNCERTAIN', 'Public npm preflight could not establish publication state; do not publish.');
  }
  if (response.status === 200) {
    await verifyIdentity(response, packageName, version, expectedGitHead);
    return { published: true };
  }
  await response.body?.cancel();
  if (response.status === 404) return { published: false };
  throw failure('NPM_PUBLICATION_PREFLIGHT_UNCERTAIN',
    `Public npm preflight returned HTTP ${response.status}; do not publish or infer that the version is absent.`);
}

/** Wait for public metadata only. This function never publishes or supplies credentials. */
export async function waitForNpmPublication({
  packageName,
  version,
  expectedGitHead,
  timeoutMs = 600_000,
  intervalMs = 5_000,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = () => performance.now(),
  onPending = () => {},
}) {
  const url = publicationUrl(packageName, version, expectedGitHead);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 ||
      !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 30_000) {
    throw failure('NPM_PUBLICATION_INPUT_INVALID', 'Publication waits must remain bounded to ten minutes.');
  }
  const started = now();
  let attempts = 0;
  for (;;) {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) {
      throw failure('NPM_PUBLICATION_TIMEOUT',
        `Timed out waiting for ${packageName}@${version}. Do not publish it again; inspect the original npm version status before resuming the Registry step.`);
    }
    attempts += 1;
    let response;
    let pendingReason;
    try {
      response = await fetchMetadata(url, fetchImpl, remaining);
    } catch {
      pendingReason = 'temporary read failure';
    }
    if (response?.status === 200) {
      await verifyIdentity(response, packageName, version, expectedGitHead);
      return { package: packageName, version, gitHead: expectedGitHead, attempts,
        waitedMs: Math.max(0, Math.round(now() - started)) };
    }
    if (response) {
      await response.body?.cancel();
      if (response.status !== 404 && response.status !== 423 && response.status !== 429 && response.status < 500) {
        throw failure('NPM_PUBLICATION_READ_REJECTED', `Public npm metadata read failed with HTTP ${response.status}.`);
      }
      pendingReason = `HTTP ${response.status}`;
    }
    onPending({ attempts, reason: pendingReason });
    const wait = Math.min(intervalMs, timeoutMs - (now() - started));
    if (wait > 0) await sleepImpl(wait);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const options = {
    packageName: packageJson.name,
    version: packageJson.version,
    expectedGitHead: process.env.GITHUB_SHA,
    onPending: ({ attempts, reason }) => console.error(`npm publication read ${attempts}: ${reason}; waiting without republishing.`),
  };
  if (process.argv.includes('--before-publish')) {
    const result = await checkNpmPublicationBeforePublish({ ...options, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
    console.log(`published=${result.published}`);
  } else {
    console.log(JSON.stringify(await waitForNpmPublication(options)));
  }
}
