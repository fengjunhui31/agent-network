import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { INSTANCE_ROOT } from '../src/paths.mjs';
import { join } from 'node:path';
import { inspectHost, invokeHost } from '../src/host-inventory.mjs';
import { HostStore, SnapshotReceiver, digest, chunkSize } from '../src/host-store.mjs';
import { codexReport } from '../src/codex-discovery.mjs';
import { writeJson } from '../src/portable-io.mjs';
async function folder(t) {
  // Release validation can run with a noexec system temp mount. Test commands live in the isolated instance.
  const base = join(INSTANCE_ROOT, '.local', 'tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'host-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('inventory identifies PATH and managed environments and shares only selected capability metadata', async (t) => {
  const root = await folder(t),
    bin = join(root, '.local/runtimes/dsh/initial/node_modules/.bin/dsh');
  await mkdir(join(bin, '..'), { recursive: true });
  await writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeJson(join(root, '.local/runtime-state.json'), { dsh: { active: 'initial' } });
  await mkdir(join(root, '.claude/skills/sample'), { recursive: true });
  await writeFile(join(root, '.claude/skills/sample/SKILL.md'), 'private instructions');
  const context = randomUUID();
  const s = await inspectHost(
    root,
    context,
    { projects: { selected: root }, documents: { notes: 'privateDocToken123' } },
    {
      home: root,
      lookup: async (n) => (['codex', 'claude', 'lark-cli'].includes(n) ? join(root, n) : null),
      version: async () => '1.2.3',
      codex: async (_dir, _client, opts) => {
        assert.equal(opts.includeSessions, false);
        return { tools: [{ source: 'mcp', name: 'docs.read' }], partial: ['mcp-unavailable'] };
      }
    }
  );
  assert(s.runtimes.some((x) => x.id === 'managed.dsh' && x.adapter === 'acp'));
  assert(s.cli.some((x) => x.name === 'lark-cli'));
  assert(s.capabilities.some((c) => c.name === 'docs.read' && c.status === 'reported'));
  assert(s.capabilities.some((c) => c.name === 'sample' && c.status === 'declared'));
  assert(s.partial.includes('mcp-unavailable'));
  assert(!JSON.stringify(s).includes(root));
  assert(!JSON.stringify(s).includes('privateDocToken'));
  assert(!JSON.stringify(s).includes('private instructions'));
});

test('capability-only Codex inspection never requests session history', async (t) => {
  const root = await folder(t),
    calls = [];
  const client = {
    call: async (m) => {
      calls.push(m);
      return m === 'skills/list' ? { data: [{ cwd: root, skills: [] }] } : { data: [] };
    },
    initialize: async () => {}
  };
  await codexReport(root, client, { includeSessions: false });
  assert.deepEqual(calls, ['skills/list', 'mcpServerStatus/list']);
});

test('host snapshot publishes atomically, rejects old generations and retains the last complete revision', async (t) => {
  const root = await folder(t),
    store = new HostStore(root),
    receiver = new SnapshotReceiver(store),
    id = randomUUID();
  const link = { networkId: randomUUID(), peerId: 'testPeer', inviteId: randomUUID() };
  await store.edit((s) => {
    s.issued[id] = {
      id,
      alias: 'lab',
      state: 'approved',
      card: { networkId: link.networkId, peerId: link.peerId },
      admission: { id: link.inviteId }
    };
  });
  const snapshot = {
    version: 1,
    contextId: randomUUID(),
    os: 'linux',
    observedAt: new Date().toISOString(),
    runtimes: [
      {
        id: 'path.codex',
        type: 'codex',
        source: 'path',
        version: '1',
        adapter: 'index-only',
        installationId: 'install-1'
      }
    ],
    cli: [],
    capabilities: Array.from({ length: 800 }, (_, i) => ({
      runtime: 'path.codex',
      source: 'skill',
      name: 'skill-' + i,
      status: 'reported'
    })),
    partial: [],
    grants: []
  };
  const b = Buffer.from(JSON.stringify(snapshot)),
    hash = digest(b),
    total = Math.ceil(b.length / chunkSize);
  const part = (index, revision = 2) => ({
    revision,
    index,
    total,
    hash,
    content: b.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64')
  });
  assert(total > 1);
  await receiver.part(id, link, part(total - 1));
  assert.equal((await store.read()).issued[id].report, undefined);
  for (let i = 0; i < total - 1; i++) await receiver.part(id, link, part(i));
  assert.equal((await new HostStore(root).read()).issued[id].report.revision, 2);
  assert.equal((await receiver.part(id, link, part(0, 1))).installed, 2);
  await assert.rejects(receiver.part(id, { ...link, inviteId: randomUUID() }, part(0)));
  await store.edit((s) => {
    s.issued[id].state = 'revoked';
    delete s.issued[id].report;
  });
  await assert.rejects(receiver.part(id, link, part(0, 3)));
});

test('Feishu can read only an explicitly selected resource under the local user identity', async (t) => {
  const root = await folder(t),
    bin = join(root, 'lark-cli');
  await writeFile(
    bin,
    `#!/bin/sh\ncase "$*" in\n  'docs +fetch --as user --doc localDoc123 --doc-format markdown') echo '{"data":{"document":{"content":"test page"}}}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o700 }
  );
  const old = process.env.PATH;
  process.env.PATH = root + ':' + old;
  try {
    assert.equal(
      (await invokeHost({ documents: { sample: 'localDoc123' } }, 'lark.document.read', 'sample')).text,
      'test page'
    );
    await assert.rejects(invokeHost({ documents: {} }, 'lark.document.read', 'sample'), /not authorized/);
    await assert.rejects(
      invokeHost({ documents: { sample: 'localDoc123' } }, 'lark.message.send', 'sample'),
      /not authorized/
    );
  } finally {
    process.env.PATH = old;
  }
});
