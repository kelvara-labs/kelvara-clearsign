// Test dApp page entry. Installs the fixture wallet three ways, discovers it like a
// dApp would, and exposes window.kelvaraTestDapp for Playwright (see test-dapp/README.md).
//
// Registration order is fixed so each Wallet Standard path is exercised on its own:
//   1. wallet B listens for 'wallet-standard:app-ready'          (app-ready path)
//   2. app listens for 'wallet-standard:register-wallet', then dispatches app-ready -> B registers
//   3. wallet A dispatches 'wallet-standard:register-wallet'     (register path)
//   4. legacy provider assigned to window.solana and window.phantom.solana
// The app always calls the wallet object it was handed by register(), so whatever the
// extension's hook put in the way is what gets called.
import { b64decode, b64encode } from "./bytes.js";
import { sampleMessage, signInInput, type MessageSample } from "./messages.js";
import { startForging, type ForgeReport } from "./forge.js";
import { FixtureStandardWallet, FixtureTxObject, makeLegacyProvider, type LegacyProvider } from "./providers.js";
import { FixtureKey, FixtureWalletCore, WALLET_PATHS, type CallLog, type WalletPath } from "./wallet.js";
import { TEST_DAPP_VERSION } from "./index.js";

const REGISTER_EVENT = "wallet-standard:register-wallet";
const APP_READY_EVENT = "wallet-standard:app-ready";

type Fn = (...args: unknown[]) => Promise<unknown>;
type AnyWallet = { name: string; features: Record<string, Record<string, unknown>> };

export type TxMethod = "signTransaction" | "signAndSendTransaction" | "signAllTransactions";

export interface SignArgs {
  path: WalletPath;
  /** base64 wire transactions (fixture bytes). */
  txs: string[];
  /** Default signTransaction (signAllTransactions when more than one tx on the legacy path). */
  method?: TxMethod;
  /** Legacy only: hand the provider raw bytes or a web3.js-like object with serialize(). Default "object". */
  legacyArg?: "bytes" | "object";
  /** Wallet Standard only: chain hint. Default "solana:devnet". */
  chain?: string;
  /** Run the forged-approval attack while this call is pending. */
  forge?: boolean;
  /**
   * base58 public key to present as the wallet's connected account for this call only (Wallet Standard
   * input.account and accounts[0]; legacy provider.publicKey), e.g. a localnet scenario's signer, so the
   * extension sees it as SignRequest.account. Public key only: the wallet signs nothing for it (the
   * transaction is counted and returned unchanged, signed: [false]). The previous account is restored after.
   */
  account?: string;
}

export type SignResult =
  | { ok: true; signed: string[]; signatures?: string[] }
  | { ok: false; error: { name: string; message: string; code: number | null } };

export interface TestDappApi {
  version: string;
  ready: Promise<void>;
  isReady: boolean;
  /** base58 address of this page's throwaway key. */
  address: string;
  /** base58 address the wallet currently shows as connected (address, or the presented one). */
  readonly account: string;
  /**
   * Present `address` (base58 public key) as the connected account on every path until changed;
   * null goes back to the throwaway key. Throws on an invalid address. SignArgs.account does the same for one call.
   */
  presentAccount(address: string | null): void;
  /** For each path: wallet discovered by the app, and whether the object/functions differ from what the wallet installed. */
  discovered: Record<WalletPath, { found: boolean; wrapped: boolean; name: string | null }>;
  sign(args: SignArgs): Promise<SignResult>;
  signMessage(path: WalletPath, text: string): Promise<SignResult>;
  /**
   * solana:signIn (legacy: provider.signIn), held and reviewed by the extension. Default input is a valid sign-in for
   * this page and account; `input` overrides fields (e.g. { domain: "evil.example" }).
   */
  signIn(path: WalletPath, input?: Record<string, string>): Promise<SignResult>;
  /**
   * signMessage with a ready-made sample: siws (valid for this page), siws-domain-mismatch, siws-expired, text, binary,
   * or tx (a serialized transaction passed as a message; needs txBase64). Read calls().timeline to see when the wallet ran.
   */
  signSample(path: WalletPath, kind: MessageSample, txBase64?: string): Promise<SignResult>;
  /** Vendor-prefixed signing feature `fixture:signBlob` (legacy: not offered, returns an error). The extension rejects it with 4001 before the wallet is called. */
  signVendor(path: WalletPath): Promise<SignResult>;
  /** Snapshot of the call log. count === 0 means the wallet was never called. */
  calls(): CallLog;
  reset(): void;
  lastForge: ForgeReport | null;
}

declare global {
  interface Window {
    kelvaraTestDapp: TestDappApi;
    solana?: unknown;
    phantom?: { solana?: unknown };
  }
}

function errorOf(e: unknown): { name: string; message: string; code: number | null } {
  const o = (e && typeof e === "object" ? e : {}) as { name?: unknown; message?: unknown; code?: unknown };
  return {
    name: typeof o.name === "string" ? o.name : "Error",
    message: typeof o.message === "string" ? o.message : String(e),
    code: typeof o.code === "number" ? o.code : null
  };
}

async function main(): Promise<void> {
  const discovered: TestDappApi["discovered"] = {
    "ws-register": { found: false, wrapped: false, name: null },
    "ws-app-ready": { found: false, wrapped: false, name: null },
    legacy: { found: false, wrapped: false, name: null }
  };
  let resolveReady!: () => void;
  const api: TestDappApi = {
    version: TEST_DAPP_VERSION,
    ready: new Promise<void>((r) => (resolveReady = r)),
    isReady: false,
    address: "",
    get account() {
      return this.address;
    },
    presentAccount: () => {
      throw new Error("test dApp not ready");
    },
    discovered,
    sign: async () => ({ ok: false, error: { name: "NotReady", message: "test dApp not ready", code: null } }),
    signMessage: async () => ({ ok: false, error: { name: "NotReady", message: "test dApp not ready", code: null } }),
    calls: () => ({ count: 0, byPath: { "ws-register": 0, "ws-app-ready": 0, legacy: 0 }, calls: [], messageCount: 0, messages: [], timeline: [] }),
    signIn: async () => ({ ok: false, error: { name: "NotReady", message: "test dApp not ready", code: null } }),
    signSample: async () => ({ ok: false, error: { name: "NotReady", message: "test dApp not ready", code: null } }),
    signVendor: async () => ({ ok: false, error: { name: "NotReady", message: "test dApp not ready", code: null } }),
    reset: () => {},
    lastForge: null
  };
  window.kelvaraTestDapp = api;

  const key = await FixtureKey.generate();
  const core = new FixtureWalletCore(key);
  api.address = key.address;

  // ---- wallets and app discovery ----
  const walletA = new FixtureStandardWallet(core, "ws-register");
  const walletB = new FixtureStandardWallet(core, "ws-app-ready");
  const originals = new Map<string, object>([
    [walletA.name, walletA],
    [walletB.name, walletB]
  ]);
  const seen: Partial<Record<WalletPath, AnyWallet>> = {};
  const makeAppApi = (path: Exclude<WalletPath, "legacy">) => ({
    register: (...wallets: unknown[]) => {
      for (const w of wallets) {
        const name = (w as AnyWallet).name;
        // Each path's api only accepts the wallet that is meant to arrive on it.
        if (name !== (path === "ws-register" ? walletA.name : walletB.name)) continue;
        seen[path] = w as AnyWallet;
        discovered[path] = { found: true, wrapped: w !== originals.get(name), name };
      }
      return () => {};
    }
  });

  // 1. wallet B: app-ready path
  window.addEventListener(APP_READY_EVENT, (e) => {
    const appApi = (e as CustomEvent<{ register: (w: unknown) => void }>).detail;
    appApi?.register?.(walletB);
  });
  // 2. app
  const registerApi = makeAppApi("ws-register");
  window.addEventListener(REGISTER_EVENT, (e) => {
    const cb = (e as CustomEvent<(a: unknown) => void>).detail;
    if (typeof cb === "function") cb(registerApi);
  });
  window.dispatchEvent(new CustomEvent(APP_READY_EVENT, { detail: makeAppApi("ws-app-ready") }));
  // 3. wallet A: register path
  window.dispatchEvent(
    new CustomEvent(REGISTER_EVENT, { detail: ({ register }: { register: (w: unknown) => void }) => register(walletA) })
  );
  // 4. legacy
  const legacy = makeLegacyProvider(core);
  const legacyOriginal = legacy.signTransaction;
  window.solana = legacy;
  window.phantom = { solana: legacy };

  const legacyProvider = (): LegacyProvider => window.solana as LegacyProvider;
  const refreshLegacy = () => {
    const p = legacyProvider();
    discovered.legacy = {
      found: !!p,
      wrapped: !!p && p.signTransaction !== legacyOriginal,
      name: p ? String((p as { name?: unknown }).name ?? "") : null
    };
  };
  refreshLegacy();

  // ---- signing ----
  async function connectWs(w: AnyWallet): Promise<unknown> {
    const res = (await (w.features["standard:connect"]!.connect as Fn)()) as { accounts: unknown[] };
    return res.accounts[0];
  }

  async function sign(args: SignArgs): Promise<SignResult> {
    const previous = core.account.address === key.address ? null : core.account.address;
    if (args.account !== undefined) {
      try {
        core.presentAccount(args.account);
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    }
    const forger = args.forge ? startForging(window) : null;
    if (forger) api.lastForge = forger.report;
    try {
      const bytes = args.txs.map(b64decode);
      if (bytes.length === 0) throw new Error("no transactions");
      if (args.path === "legacy") {
        refreshLegacy();
        const p = legacyProvider();
        await p.connect();
        const wrap = (b: Uint8Array) => (args.legacyArg === "bytes" ? b : new FixtureTxObject(b));
        const read = (x: unknown) => b64encode(x instanceof Uint8Array ? x : (x as FixtureTxObject).serialize());
        const method = args.method ?? (bytes.length > 1 ? "signAllTransactions" : "signTransaction");
        if (method === "signAllTransactions") {
          const out = await p.signAllTransactions(bytes.map(wrap));
          return { ok: true, signed: out.map(read) };
        }
        if (bytes.length !== 1) throw new Error(`${method} takes one transaction`);
        if (method === "signAndSendTransaction") {
          const out = await p.signAndSendTransaction(wrap(bytes[0]!));
          return { ok: true, signed: [], signatures: [out.signature] };
        }
        const out = await p.signTransaction(wrap(bytes[0]!));
        return { ok: true, signed: [read(out)] };
      }
      const w = seen[args.path];
      if (!w) throw new Error(`no wallet discovered on ${args.path}`);
      const account = await connectWs(w);
      const chain = args.chain ?? "solana:devnet";
      const inputs = bytes.map((transaction) => ({ account, transaction, chain }));
      const method = args.method ?? "signTransaction";
      if (method === "signAndSendTransaction") {
        const f = w.features["solana:signAndSendTransaction"]!;
        const out = (await (f.signAndSendTransaction as Fn)(...inputs)) as { signature: Uint8Array }[];
        return { ok: true, signed: [], signatures: out.map((o) => b64encode(o.signature)) };
      }
      const f = w.features["solana:signTransaction"]!;
      const out = (await (f.signTransaction as Fn)(...inputs)) as { signedTransaction: Uint8Array }[];
      return { ok: true, signed: out.map((o) => b64encode(o.signedTransaction)) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    } finally {
      forger?.stop();
      if (args.account !== undefined) core.presentAccount(previous);
    }
  }

  const signMessage = (path: WalletPath, text: string) => signMessageBytes(path, new TextEncoder().encode(text));
  async function signMessageBytes(path: WalletPath, msg: Uint8Array): Promise<SignResult> {
    try {
      if (path === "legacy") {
        const out = await legacyProvider().signMessage(msg);
        return { ok: true, signed: [], signatures: [b64encode(out.signature)] };
      }
      const w = seen[path];
      if (!w) throw new Error(`no wallet discovered on ${path}`);
      const account = await connectWs(w);
      const out = (await (w.features["solana:signMessage"]!.signMessage as Fn)({ account, message: msg })) as {
        signature: Uint8Array;
      }[];
      return { ok: true, signed: [], signatures: out.map((o) => b64encode(o.signature)) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  }

  async function viaFeature(path: WalletPath, key: string, fn: string, input: Record<string, unknown>): Promise<SignResult> {
    try {
      if (path === "legacy") {
        if (key !== "solana:signIn") throw new Error("no vendor feature on legacy");
        const out = await legacyProvider().signIn(input);
        return { ok: true, signed: [], signatures: [b64encode(out.signature)] };
      }
      const w = seen[path];
      if (!w) throw new Error(`no wallet discovered on ${path}`);
      const account = await connectWs(w);
      const out = (await (w.features[key]![fn] as Fn)(key === "solana:signIn" ? input : { account, ...input })) as { signature: Uint8Array }[];
      return { ok: true, signed: [], signatures: out.map((o) => b64encode(o.signature)) };
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  }

  Object.defineProperty(api, "account", { get: () => core.account.address, enumerable: true });
  api.presentAccount = (address) => {
    core.presentAccount(address);
    $("account").textContent = core.account.address;
  };
  api.sign = sign;
  api.signMessage = signMessage;
  api.signIn = (path, input) =>
    viaFeature(path, "solana:signIn", "signIn", { ...signInInput({ host: location.host, origin: location.origin }, core.account.address), ...input });
  api.signSample = async (path, kind, txBase64) => {
    try {
      return await signMessageBytes(path, sampleMessage(kind, { host: location.host, origin: location.origin }, core.account.address, txBase64));
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  };
  api.signVendor = (path) => viaFeature(path, "fixture:signBlob", "signBlob", { blob: new Uint8Array([1, 2, 3]) });
  api.calls = () => structuredClone(core.log);
  api.reset = () => core.reset();

  // ---- visible page ----
  const $ = (id: string) => document.getElementById(id)!;
  const render = (log: CallLog) => {
    const el = $("call-count");
    el.textContent = String(log.count);
    el.dataset.count = String(log.count);
    for (const p of WALLET_PATHS) $(`count-${p}`).textContent = String(log.byPath[p]);
    $("message-count").textContent = String(log.messageCount);
    $("call-log").textContent = log.calls
      .map((c) => `#${c.n} ${c.path} ${c.method} txs=${c.received.length} signed=${c.signed.join(",") || "…"}`)
      .join("\n");
  };
  core.onChange(render);
  render(core.log);
  $("address").textContent = key.address;
  $("account").textContent = core.account.address;
  for (const p of WALLET_PATHS) {
    const d = discovered[p];
    $(`found-${p}`).textContent = d.found ? (d.wrapped ? "found, wrapped by extension" : "found, not wrapped") : "not found";
  }

  const result = $("result");
  const show = (r: SignResult) => {
    result.textContent = JSON.stringify(r, null, 2);
    result.dataset.ok = String(r.ok);
  };
  const txInput = $("tx-input") as HTMLTextAreaElement;
  const pathInput = $("path-input") as HTMLSelectElement;
  const methodInput = $("method-input") as HTMLSelectElement;
  $("sign-btn").addEventListener("click", async () => {
    const txs = txInput.value.split(/\s+/).filter(Boolean);
    show(await sign({ path: pathInput.value as WalletPath, txs, method: methodInput.value as TxMethod }));
  });
  $("forge-btn").addEventListener("click", async () => {
    const txs = txInput.value.split(/\s+/).filter(Boolean);
    show(await sign({ path: pathInput.value as WalletPath, txs, method: methodInput.value as TxMethod, forge: true }));
  });
  $("msg-btn").addEventListener("click", async () => show(await signMessage(pathInput.value as WalletPath, "Kelvara test message")));
  $("reset-btn").addEventListener("click", () => core.reset());

  api.isReady = true;
  document.documentElement.dataset.testDappReady = "true";
  resolveReady();
}

main().catch((e) => {
  document.documentElement.dataset.testDappError = String(e);
  console.error("test dApp failed to start", e);
});
