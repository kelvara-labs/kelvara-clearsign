// Minimal Solana wire-format parser, used only to check which programs a fetched tx invokes.
// Handles legacy and v0 messages. Other versions throw UnsupportedVersion so the caller can decide.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export class UnsupportedVersion extends Error {
  constructor(version) {
    super(`unsupported transaction message version ${version}`);
    this.version = version;
  }
}

export function parseWireTransaction(bytes) {
  let o = 0;
  const need = (n) => {
    if (o + n > bytes.length) throw new Error(`truncated at ${o} (+${n}) of ${bytes.length}`);
  };
  const u8 = () => {
    need(1);
    return bytes[o++];
  };
  const shortvec = () => {
    let v = 0;
    for (let s = 0; s < 21; s += 7) {
      const b = u8();
      v |= (b & 0x7f) << s;
      if (!(b & 0x80)) return v;
    }
    throw new Error('bad compact-u16');
  };
  const take = (n) => {
    need(n);
    const out = bytes.subarray(o, o + n);
    o += n;
    return out;
  };

  const sigCount = shortvec();
  const signatures = [];
  for (let i = 0; i < sigCount; i++) signatures.push(base58(take(64)));

  let version = 'legacy';
  if (bytes[o] & 0x80) {
    const v = u8() & 0x7f;
    if (v !== 0) throw new UnsupportedVersion(v);
    version = 0;
  }
  const header = { required: u8(), readonlySigned: u8(), readonlyUnsigned: u8() };
  const keyCount = shortvec();
  const staticAccountKeys = [];
  for (let i = 0; i < keyCount; i++) staticAccountKeys.push(base58(take(32)));
  const recentBlockhash = base58(take(32));
  const ixCount = shortvec();
  const instructions = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = u8();
    const accounts = [...take(shortvec())];
    const data = take(shortvec());
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups = [];
  if (version === 0) {
    const n = shortvec();
    for (let i = 0; i < n; i++) {
      const account = base58(take(32));
      const writable = [...take(shortvec())];
      const readonly = [...take(shortvec())];
      lookups.push({ account, writable, readonly });
    }
  }
  if (o !== bytes.length) throw new Error(`trailing bytes: parsed ${o} of ${bytes.length}`);
  return { signatures, version, header, staticAccountKeys, recentBlockhash, instructions, lookups };
}
