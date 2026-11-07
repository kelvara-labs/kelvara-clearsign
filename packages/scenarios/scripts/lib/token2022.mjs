// Hand-encoded Token-2022, Associated Token Account and System instructions for the localnet trap scenario.
// Layouts follow spl-token-2022 (instruction tags, Pod/COption packing, TLV extensions) and the
// spl-token-metadata-interface; no @solana/spl-token dependency. Localnet only.
/* global Buffer */
import { createHash } from 'node:crypto';
import { SYSTEM_PROGRAM, b58decode, b58encode, findProgramAddress } from './tx.mjs';

export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// Extension types (spl_token_2022::extension::ExtensionType)
export const EXT = { PermanentDelegate: 12, MetadataPointer: 18, TokenMetadata: 19 };

const BASE_ACCOUNT_LEN = 165; // mint data is padded to the account length, then 1 byte AccountType
const MINT_ACCOUNT_TYPE = 1;

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const pk = (k) => Buffer.from(b58decode(k));
const u8 = (n) => Buffer.from([n]);
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const borshString = (s) => Buffer.concat([u32le(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);

// ---- System ----
export const createAccount = (from, to, lamports, space, owner) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(from, true, true), meta(to, true, true)],
  data: Buffer.concat([u32le(0), u64le(lamports), u64le(space), pk(owner)])
});
export const systemTransfer = (from, to, lamports) => ({
  programId: SYSTEM_PROGRAM,
  keys: [meta(from, true, true), meta(to, false, true)],
  data: Buffer.concat([u32le(2), u64le(lamports)])
});

// ---- sizes ----
// Mint with PermanentDelegate (32) and MetadataPointer (authority 32 + address 32), before TokenMetadata.
export const MINT_LEN_FIXED = BASE_ACCOUNT_LEN + 1 + (4 + 32) + (4 + 64);
export const tokenMetadataLen = ({ name, symbol, uri }) =>
  4 + 32 + 32 + 4 + Buffer.byteLength(name) + 4 + Buffer.byteLength(symbol) + 4 + Buffer.byteLength(uri) + 4;

// ---- Token-2022 ----
// InitializePermanentDelegate (35): [mint w]
export const initializePermanentDelegate = (mint, delegate) => ({
  programId: TOKEN_2022,
  keys: [meta(mint, false, true)],
  data: Buffer.concat([u8(35), pk(delegate)])
});
// MetadataPointerExtension (39) / Initialize (0): OptionalNonZeroPubkey authority, metadata address
export const initializeMetadataPointer = (mint, authority, metadataAddress) => ({
  programId: TOKEN_2022,
  keys: [meta(mint, false, true)],
  data: Buffer.concat([u8(39), u8(0), authority ? pk(authority) : Buffer.alloc(32), pk(metadataAddress)])
});
// InitializeMint2 (20): decimals, mint authority, COption<Pubkey> freeze authority (1-byte tag)
export const initializeMint2 = (mint, decimals, mintAuthority, freezeAuthority) => ({
  programId: TOKEN_2022,
  keys: [meta(mint, false, true)],
  data: Buffer.concat([u8(20), u8(decimals), pk(mintAuthority), freezeAuthority ? Buffer.concat([u8(1), pk(freezeAuthority)]) : u8(0)])
});
// spl-token-metadata-interface Initialize: [metadata w, update authority, mint, mint authority s]
export const TOKEN_METADATA_INITIALIZE = createHash('sha256').update('spl_token_metadata_interface:initialize_account').digest().subarray(0, 8);
export const initializeTokenMetadata = ({ mint, updateAuthority, mintAuthority, name, symbol, uri }) => ({
  programId: TOKEN_2022,
  keys: [meta(mint, false, true), meta(updateAuthority, false, false), meta(mint, false, false), meta(mintAuthority, true, false)],
  data: Buffer.concat([TOKEN_METADATA_INITIALIZE, borshString(name), borshString(symbol), borshString(uri)])
});
// MintTo (7): [mint w, destination w, mint authority s]
export const mintTo = (mint, destination, authority, amount) => ({
  programId: TOKEN_2022,
  keys: [meta(mint, false, true), meta(destination, false, true), meta(authority, true, false)],
  data: Buffer.concat([u8(7), u64le(amount)])
});
// TransferChecked (12): [source w, mint, destination w, authority s]; authority may be owner, delegate or permanent delegate
export const transferChecked = (source, mint, destination, authority, amount, decimals) => ({
  programId: TOKEN_2022,
  keys: [meta(source, false, true), meta(mint, false, false), meta(destination, false, true), meta(authority, true, false)],
  data: Buffer.concat([u8(12), u64le(amount), u8(decimals)])
});
// BurnChecked (15): [account w, mint w, authority s]
export const burnChecked = (account, mint, authority, amount, decimals) => ({
  programId: TOKEN_2022,
  keys: [meta(account, false, true), meta(mint, false, true), meta(authority, true, false)],
  data: Buffer.concat([u8(15), u64le(amount), u8(decimals)])
});
// CloseAccount (9): [account w, destination w, owner s]; the balance must be 0, the rent goes to destination
export const closeAccount = (account, destination, owner) => ({
  programId: TOKEN_2022,
  keys: [meta(account, false, true), meta(destination, false, true), meta(owner, true, false)],
  data: u8(9)
});
// FreezeAccount (10): [account w, mint, freeze authority s]
export const freezeAccount = (account, mint, authority) => ({
  programId: TOKEN_2022,
  keys: [meta(account, false, true), meta(mint, false, false), meta(authority, true, false)],
  data: u8(10)
});

// ---- Associated token account ----
export const ataAddress = (owner, mint, tokenProgram = TOKEN_2022) => findProgramAddress([pk(owner), pk(tokenProgram), pk(mint)], ATA_PROGRAM)[0];
// CreateIdempotent (1): [payer s w, ata w, owner, mint, system, token program]
export const createAtaIdempotent = (payer, owner, mint, tokenProgram = TOKEN_2022) => ({
  programId: ATA_PROGRAM,
  keys: [
    meta(payer, true, true),
    meta(ataAddress(owner, mint, tokenProgram), false, true),
    meta(owner, false, false),
    meta(mint, false, false),
    meta(SYSTEM_PROGRAM, false, false),
    meta(tokenProgram, false, false)
  ],
  data: u8(1)
});

// ---- decoders ----
const coption = (b, off) => (b.readUInt32LE(off) === 1 ? b58encode(b.subarray(off + 4, off + 36)) : null);

export function parseMint(bytes) {
  const b = Buffer.from(bytes);
  const mint = {
    mintAuthority: coption(b, 0),
    supply: b.readBigUInt64LE(36),
    decimals: b[44],
    isInitialized: b[45] === 1,
    freezeAuthority: coption(b, 46),
    extensions: {}
  };
  if (b.length > BASE_ACCOUNT_LEN) {
    if (b[BASE_ACCOUNT_LEN] !== MINT_ACCOUNT_TYPE) throw new Error('not a Token-2022 mint (account type)');
    let off = BASE_ACCOUNT_LEN + 1;
    while (off + 4 <= b.length) {
      const type = b.readUInt16LE(off);
      const len = b.readUInt16LE(off + 2);
      if (type === 0) break;
      const v = b.subarray(off + 4, off + 4 + len);
      if (type === EXT.PermanentDelegate) mint.extensions.permanentDelegate = b58encode(v);
      else if (type === EXT.MetadataPointer) mint.extensions.metadataPointer = { authority: v.subarray(0, 32).every((x) => x === 0) ? null : b58encode(v.subarray(0, 32)), metadataAddress: b58encode(v.subarray(32, 64)) };
      else if (type === EXT.TokenMetadata) {
        let o = 64;
        const str = () => {
          const n = v.readUInt32LE(o);
          const s = v.subarray(o + 4, o + 4 + n).toString('utf8');
          o += 4 + n;
          return s;
        };
        mint.extensions.tokenMetadata = { updateAuthority: b58encode(v.subarray(0, 32)), mint: b58encode(v.subarray(32, 64)), name: str(), symbol: str(), uri: str() };
      } else mint.extensions[`type${type}`] = v.toString('hex');
      off += 4 + len;
    }
  }
  return mint;
}

export const ACCOUNT_STATE = ['Uninitialized', 'Initialized', 'Frozen'];
export function parseTokenAccount(bytes) {
  const b = Buffer.from(bytes);
  return { mint: b58encode(b.subarray(0, 32)), owner: b58encode(b.subarray(32, 64)), amount: b.readBigUInt64LE(64), delegate: coption(b, 72), state: ACCOUNT_STATE[b[108]] };
}
