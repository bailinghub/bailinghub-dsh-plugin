import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkNpmPublicationBeforePublish, waitForNpmPublication } from '../scripts/wait-npm-publication.mjs';

const expected = { packageName: 'dsh-bailinghub', version: '0.8.0', expectedGitHead: 'a'.repeat(40) };
const metadata = { name: expected.packageName, version: expected.version, gitHead: expected.expectedGitHead };

function fixture(responses) {
  let elapsed = 0;
  const requests = [], waits = [], pending = [];
  return {
    requests, waits, pending,
    options: {
      ...expected, timeoutMs: 30, intervalMs: 10,
      now: () => elapsed,
      sleepImpl: async (ms) => { waits.push(ms); elapsed += ms; },
      onPending: (value) => pending.push(value),
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        const value = responses.length > 1 ? responses.shift() : responses[0];
        if (value instanceof Error) throw value;
        return new Response(JSON.stringify(value.body ?? {}), { status: value.status });
      },
    },
  };
}

test('publication wait accepts exact readable npm identity using only a public GET', async () => {
  const f = fixture([{ status: 200, body: metadata }]);
  const result = await waitForNpmPublication(f.options);
  assert.equal(result.gitHead, expected.expectedGitHead);
  assert.equal(result.attempts, 1);
  assert.equal(f.waits.length, 0);
  assert.equal(f.requests[0].url, 'https://registry.npmjs.org/dsh-bailinghub/0.8.0');
  assert.equal(f.requests[0].init.method, 'GET');
  assert.equal(f.requests[0].init.headers.authorization, undefined);
});

test('accepted but not yet public version waits through 404 and temporary reads without publishing', async () => {
  const f = fixture([{ status: 404 }, new Error('temporary network error'), { status: 200, body: metadata }]);
  const result = await waitForNpmPublication(f.options);
  assert.equal(result.attempts, 3);
  assert.equal(result.waitedMs, 20);
  assert.equal(f.pending.length, 2);
  assert.deepEqual(f.requests.map(({ init }) => init.method), ['GET', 'GET', 'GET']);
});

test('locked processing, rate limits and temporary service failures remain read-only waits', async () => {
  const f = fixture([{ status: 423 }, { status: 429 }, { status: 503 }, { status: 200, body: metadata }]);
  f.options.timeoutMs = 40;
  assert.equal((await waitForNpmPublication(f.options)).attempts, 4);
  assert.deepEqual(f.requests.map(({ init }) => init.method), ['GET', 'GET', 'GET', 'GET']);
});

test('only an initial missing version permits publish; a rerun must first read the accepted identity', async () => {
  const absent = fixture([{ status: 404 }]);
  assert.deepEqual(await checkNpmPublicationBeforePublish({ ...absent.options, runAttempt: 1 }), { published: false });
  const readable = fixture([{ status: 200, body: metadata }]);
  assert.equal((await checkNpmPublicationBeforePublish({ ...readable.options, runAttempt: 1 })).published, true);
  const processing = fixture([{ status: 404 }, { status: 200, body: metadata }]);
  assert.equal((await checkNpmPublicationBeforePublish({ ...processing.options, runAttempt: 2 })).published, true);
  assert.deepEqual(processing.requests.map(({ init }) => init.method), ['GET', 'GET']);
  await assert.rejects(checkNpmPublicationBeforePublish({ ...absent.options, runAttempt: 2 }), { code: 'NPM_PUBLICATION_TIMEOUT' });
});

test('uncertain initial preflight never converts locked, rejected or network errors into publish permission', async () => {
  for (const response of [{ status: 423 }, { status: 429 }, { status: 503 }, new Error('network')]) {
    const f = fixture([response]);
    await assert.rejects(checkNpmPublicationBeforePublish({ ...f.options, runAttempt: 1 }), { code: 'NPM_PUBLICATION_PREFLIGHT_UNCERTAIN' });
    assert.equal(f.requests.length, 1);
  }
});

test('publication timeout is bounded and forbids a replacement publish', async () => {
  const f = fixture([{ status: 404 }]);
  await assert.rejects(waitForNpmPublication(f.options), (error) => {
    assert.equal(error.code, 'NPM_PUBLICATION_TIMEOUT');
    assert.match(error.message, /Do not publish it again/);
    return true;
  });
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.waits, [10, 10, 10]);
});

test('readable mismatched package, version or commit fails immediately', async () => {
  for (const patch of [{ name: 'other-package' }, { version: '0.7.0' }, { gitHead: 'b'.repeat(40) }, { gitHead: undefined }]) {
    const f = fixture([{ status: 200, body: { ...metadata, ...patch } }]);
    await assert.rejects(waitForNpmPublication(f.options), { code: 'NPM_PUBLICATION_IDENTITY_MISMATCH' });
    assert.equal(f.requests.length, 1);
    assert.equal(f.waits.length, 0);
  }
});

test('public read rejection and invalid unbounded inputs never retry a publication', async () => {
  const f = fixture([{ status: 403 }]);
  await assert.rejects(waitForNpmPublication(f.options), { code: 'NPM_PUBLICATION_READ_REJECTED' });
  assert.equal(f.requests.length, 1);
  await assert.rejects(waitForNpmPublication({ ...f.options, timeoutMs: 600_001 }), { code: 'NPM_PUBLICATION_INPUT_INVALID' });
  assert.equal(f.requests.length, 1);
});

test('oversized or malformed public metadata fails without logging or retrying its body', async () => {
  for (const body of ['{"oversized":"' + 'x'.repeat(262_144) + '"}', 'not JSON']) {
    const f = fixture([]);
    let calls = 0;
    f.options.fetchImpl = async () => { calls += 1; return new Response(body); };
    await assert.rejects(waitForNpmPublication(f.options), (error) => {
      assert.equal(error.code, 'NPM_PUBLICATION_INVALID');
      assert.equal(error.message.includes(body), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(f.waits.length, 0);
  }
});

test('DSH publication uses strict preflight and at most one bounded visibility wait', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const preflight = workflow.indexOf('run: node scripts/wait-npm-publication.mjs --before-publish');
  const publish = workflow.indexOf('run: npm publish --access public');
  const wait = workflow.indexOf('run: node scripts/wait-npm-publication.mjs', publish);
  assert.ok(preflight >= 0 && publish > preflight && wait > publish);
  assert.equal(workflow.includes('npm view'), false);
  assert.match(workflow, /GITHUB_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /name: Wait for exact npm publication and verify source identity\s+if: steps\.npm-version\.outputs\.published != 'true'/);
});
