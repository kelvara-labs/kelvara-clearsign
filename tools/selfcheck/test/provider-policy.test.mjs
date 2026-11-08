import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerOrigin, providerRequestAllowed } from '../src/provider-policy.mjs';

test('provider endpoint oracle rejects credentials, query, fragments and unsafe schemes', () => {
  for (const u of ['http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/?key=x', 'https://example.com/#key', 'file:///tmp/model', 'javascript:alert(1)', 'https://localhost.evil.test/?x']) {
    assert.equal(providerOrigin(u), null, u);
  }
  assert.equal(providerOrigin('https://api.openai.com/v1'), 'https://api.openai.com');
  assert.equal(providerOrigin('http://127.0.0.1:9999/v1'), 'http://127.0.0.1:9999');
});

test('provider runtime oracle needs exact configured origin AND observed exact grant; no redirects', () => {
  const configured = 'https://model.example:9443/v1';
  const grants = ['https://model.example:9443/*'];
  assert.equal(providerRequestAllowed(`${configured}/chat/completions`, configured, grants), true);
  for (const request of ['https://foreign.example/v1', 'https://model.example/v1', 'http://model.example:9443/v1', 'https://model.example.evil.test:9443/v1', 'https://user:pass@model.example:9443/v1', `${configured}?key=seed`]) {
    assert.equal(providerRequestAllowed(request, configured, grants), false, request);
  }
  assert.equal(providerRequestAllowed(configured, configured, ['https://*/*']), false);
  assert.equal(providerRequestAllowed(configured, configured, []), false);
  assert.equal(providerRequestAllowed(configured, configured, grants, true), false);
  assert.equal(providerRequestAllowed(configured, 'https://new.example/v1', grants), false);
});

test('provider oracle accepts Chrome port-less grant only for the exact scheme and host', () => {
  const configured = 'http://127.0.0.1:41234/v1/chat/completions';
  assert.equal(providerRequestAllowed(configured, configured, ['http://127.0.0.1/*']), true);
  for (const grants of [['http://localhost/*'], ['https://127.0.0.1/*'], ['http://*/*'], ['<all_urls>'], ['http://127.0.0.2/*']]) {
    assert.equal(providerRequestAllowed(configured, configured, grants), false, grants.join());
  }
  assert.equal(providerRequestAllowed('http://127.0.0.1:9/v1', configured, ['http://127.0.0.1/*']), false);
});
