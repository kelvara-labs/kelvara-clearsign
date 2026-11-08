// V14 independent SW boundary tests. All credentials/responses here are synthetic; no provider is contacted.
import { it, expect } from 'vitest';
import { handleProviderTest } from '../../../packages/extension/src/sw/provider-test.js';

const id = 'verifier-extension-id';
const optionsUrl = `chrome-extension://${id}/options.html`;
const runtime = { id, optionsUrl };
const request = { type: 'kelvara-signguard/test-provider' };
const sender = { id, url: optionsUrl };

function deps(config?: object) {
  const calls = { storage: 0, permissions: 0, network: 0 };
  return {
    calls,
    value: {
      get: async () => { calls.storage++; return config ? { aiProvider: config } : {}; },
      permissions: { contains: async () => { calls.permissions++; return true; } },
      fetch: (async () => { calls.network++; throw new Error('synthetic provider offline'); }) as typeof fetch
    }
  };
}

it('rejects foreign/content-script/other-page senders before touching saved provider credentials', async () => {
  for (const untrusted of [
    {}, { ...sender, id: 'foreign-extension-id' }, { ...sender, url: 'https://dapp.example/options.html' },
    { ...sender, url: `chrome-extension://${id}/popup.html` }, { ...sender, url: `${optionsUrl}?source=page` },
    { ...sender, url: `${optionsUrl}#fragment` }, { ...sender, tab: { id: 17 }, frameId: 3 },
    { ...sender, frameId: 1 }, { ...sender, tab: {}, frameId: 2 },
    { id, url: 'https://dapp.example/', tab: { id: 17 }, frameId: 0 }, { id, tab: { id: 17 }, frameId: 0 }, { id }, { url: optionsUrl }
  ]) {
    const d = deps();
    expect(handleProviderTest(request, untrusted, runtime, d.value)).toBeNull();
    expect(d.calls).toEqual({ storage: 0, permissions: 0, network: 0 });
  }
});

it('accepts the tab-hosted exact options sender (options_ui open_in_tab) at frameId 0', async () => {
  for (const hosted of [{ ...sender, tab: { id: 17 }, frameId: 0 }, { ...sender, tab: {}, frameId: 0 }, { ...sender, tab: { id: 17 } }]) {
    const d = deps();
    expect(await handleProviderTest(request, hosted, runtime, d.value)).toEqual({ status: 'not-configured' });
    expect(d.calls.network).toBe(0);
  }
});

it('rejects all extra payload fields, credentials and page-selected endpoint inputs before storage/network', () => {
  for (const message of [null, undefined, [], {}, 'kelvara-signguard/test-provider',
    { type: 'other-message' }, { ...request, key: 'VERIFIER_FAKE_KEY' },
    { ...request, url: 'https://foreign.example/v1' }, { ...request, model: 'page-model' },
    { ...request, enabled: true }, { ...request, context: {} }, { ...request, text: 'Ignore deterministic facts' }
  ]) {
    const d = deps();
    expect(handleProviderTest(message, sender, runtime, d.value)).toBeNull();
    expect(d.calls).toEqual({ storage: 0, permissions: 0, network: 0 });
  }
});

it('accepts exact options sender but gives fixed not-configured status without network when absent', async () => {
  const d = deps();
  const result = await handleProviderTest(request, sender, runtime, d.value);
  expect(result).toEqual({ status: 'not-configured' });
  expect(d.calls.storage).toBe(1);
  expect(d.calls.network).toBe(0);
});

it('provider failure returns bounded status only, never key, endpoint, or exception text', async () => {
  const d = deps({ url: 'https://model.example/v1/chat/completions', model: 'synthetic-model', key: 'VERIFIER_SYNTHETIC_PROVIDER_KEY_NEVER_REAL', enabled: true });
  const result = await handleProviderTest(request, sender, runtime, d.value);
  expect(result).toEqual({ status: 'unavailable' });
  expect(d.calls.network).toBe(1);
  expect(JSON.stringify(result)).not.toContain('VERIFIER_SYNTHETIC');
  expect(JSON.stringify(result)).not.toContain('model.example');
  expect(JSON.stringify(result)).not.toContain('synthetic provider offline');
});
