import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTransferFee, readFeeConfig } from '../scripts/demo-prepare-fees.mjs';
test('fee state reader rejects wrong account type and incomplete extension', () => {
  assert.throws(() => readFeeConfig(new Uint8Array(82)));
  assert.throws(() => readFeeConfig(new Uint8Array(278)));
});
test('fee instruction rejects out of range values rather than truncating', () => {
  assert.throws(() => setTransferFee('11111111111111111111111111111111', '11111111111111111111111111111111', 65536, 1));
  assert.throws(() => setTransferFee('11111111111111111111111111111111', '11111111111111111111111111111111', 1, -1));
});
