// V14 independent options contract. No real model key or paid network request is used.
import { test, expect } from './support.js';

test('provider URL, key and model stay collapsed on initial load and reload; key never prefilled', async ({ ext }) => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extId}/options.html`);
  const details = options.locator('#ai-provider');
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute('open', /.*/);
  for (const selector of ['#ai-url', '#ai-key', '#ai-model']) await expect(options.locator(selector)).toBeHidden();
  await details.locator('summary').click();
  for (const selector of ['#ai-url', '#ai-key', '#ai-model']) await expect(options.locator(selector)).toBeVisible();
  await expect(options.locator('#ai-key')).toHaveAttribute('type', 'password');
  await expect(options.locator('#ai-key')).toHaveValue('');
  await options.reload();
  await expect(details).not.toHaveAttribute('open', /.*/);
  for (const selector of ['#ai-url', '#ai-key', '#ai-model']) await expect(options.locator(selector)).toBeHidden();
  await details.locator('summary').click();
  await expect(options.locator('#ai-key')).toHaveValue('');
  await options.close();
});

test('saved seeded provider key is never prefilled or exposed by options reload', async ({ ext }) => {
  await ext.sw.evaluate(async () => {
    const c = (globalThis as unknown as { chrome: { storage: { local: { set(v: object): Promise<void> } } } }).chrome;
    await c.storage.local.set({ aiProvider: { url: 'https://api.openai.com/v1', model: 'mock-model', key: 'VERIFIER_FAKE_PROVIDER_KEY_NEVER_REAL', enabled: false } });
  });
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extId}/options.html`);
  await expect(options.locator('#ai-provider')).not.toHaveAttribute('open', /.*/);
  await options.locator('#ai-provider summary').click();
  await expect(options.locator('#ai-key')).toHaveValue('');
  expect(await options.locator('body').innerText()).not.toContain('VERIFIER_FAKE_PROVIDER_KEY_NEVER_REAL');
  expect(await options.content()).not.toContain('VERIFIER_FAKE_PROVIDER_KEY_NEVER_REAL');
  await options.locator('#ai-delete').click();
  const saved = await ext.sw.evaluate(async () => {
    const c = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome;
    return (await c.storage.local.get('aiProvider')).aiProvider;
  });
  expect(saved).toBeUndefined();
  await options.close();
});

test('actual Chrome options tab can test saved provider through authenticated service worker', async ({ ext }) => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extId}/options.html`);
  await options.locator('#ai-provider summary').click();
  await options.locator('#ai-test').click();
  await expect(options.locator('#ai-result')).toHaveText('Save a provider before testing it.');
  // Assert the precise fixed SW result using Chrome's actual options sender metadata as well.
  const result = await options.evaluate(async () => {
    const c = (globalThis as unknown as { chrome: { runtime: { sendMessage(v: object): Promise<unknown> } } }).chrome;
    return c.runtime.sendMessage({ type: 'kelvara-signguard/test-provider' });
  });
  expect(result).toEqual({ status: 'not-configured' });
  await options.close();
});
