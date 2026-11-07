// Test dApp: static page + fixture wallet for the G7 end-to-end specs.
// Page API types for specs in test-dapp/e2e; the page itself is src/app.ts.
export const TEST_DAPP_VERSION = "0.1.0";
export type { CallLog, CallRecord, MessageRecord, WalletPath } from "./wallet.js";
export type { SignArgs, SignResult, TestDappApi, TxMethod } from "./app.js";
export type { ForgeReport } from "./forge.js";
