// Address Lookup Table account layout (solana-program address-lookup-table, state.rs):
//   u32 type (1 = LookupTable), u64 deactivation_slot, u64 last_extended_slot,
//   u8 last_extended_slot_start_index, Option<Pubkey> authority (1 + 32), u16 padding
//   = 56 bytes of metadata, then 32-byte addresses.
import { getAddressDecoder, type Address } from "@solana/kit";
import type { LookupTableInfo } from "./types.js";

export const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const META_SIZE = 56;
const addressDecoder = getAddressDecoder();

/** Returns null when the data is not a valid lookup table. */
export function parseLookupTableData(address: Address, data: Uint8Array): LookupTableInfo | null {
  if (data.length < META_SIZE || (data.length - META_SIZE) % 32 !== 0) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 1) return null;
  const deactivationSlot = view.getBigUint64(4, true);
  const lastExtendedSlot = view.getBigUint64(12, true);
  const hasAuthority = data[21];
  if (hasAuthority !== 0 && hasAuthority !== 1) return null;
  const authority = hasAuthority === 1 ? addressDecoder.decode(data.subarray(22, 54)) : null;
  const addresses: Address[] = [];
  for (let off = META_SIZE; off < data.length; off += 32) {
    addresses.push(addressDecoder.decode(data.subarray(off, off + 32)));
  }
  return { address, authority, deactivationSlot, lastExtendedSlot, addresses };
}

export const U64_MAX = 0xffffffffffffffffn;
