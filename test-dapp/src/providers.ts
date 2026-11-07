// The fixture wallet as a dApp sees it: a Wallet Standard wallet (one instance per
// registration path) and a legacy injected provider. Shapes follow
// @wallet-standard/base and @solana/wallet-standard-features, written out by hand
// so the test dApp has no dependencies.
import { b58encode } from "./bytes.js";
import { firstSignature, type FixtureWalletCore, type WalletPath } from "./wallet.js";

export const SOLANA_CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"] as const;

const ICON =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#3b4a6b"/></svg>');

interface WsAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
}

interface SignTxInput {
  account: WsAccount;
  transaction: Uint8Array;
  chain?: string;
  options?: unknown;
}

const asBytes = (x: unknown): Uint8Array => {
  if (x instanceof Uint8Array) return x;
  throw new TypeError("fixture wallet: transaction must be a Uint8Array");
};

/**
 * A Wallet Standard wallet. Uses #private fields and getters like real wallets do,
 * so the extension's wrapper has to keep `this` intact to work.
 */
export class FixtureStandardWallet {
  readonly #core: FixtureWalletCore;
  readonly #path: WalletPath;
  readonly #name: string;
  #account: WsAccount | null = null;
  #connected = false;
  readonly #listeners = new Set<(props: unknown) => void>();

  constructor(core: FixtureWalletCore, path: Exclude<WalletPath, "legacy">) {
    this.#core = core;
    this.#path = path;
    this.#name = path === "ws-register" ? "Kelvara Fixture (register)" : "Kelvara Fixture (app-ready)";
  }

  /** The core's current account (throwaway key or a presented address), one frozen object per address. */
  get #current(): WsAccount {
    const a = this.#core.account;
    if (this.#account?.address !== a.address)
      this.#account = Object.freeze({
        address: a.address,
        publicKey: a.publicKey.slice(),
        chains: SOLANA_CHAINS,
        features: ["solana:signTransaction", "solana:signAndSendTransaction", "solana:signMessage"]
      });
    return this.#account;
  }

  get version() {
    return "1.0.0" as const;
  }
  get name() {
    return this.#name;
  }
  get icon() {
    return ICON;
  }
  get chains() {
    return SOLANA_CHAINS;
  }
  get accounts(): readonly WsAccount[] {
    return this.#connected ? [this.#current] : [];
  }

  get features() {
    return {
      "standard:connect": { version: "1.0.0", connect: this.#connect },
      "standard:disconnect": { version: "1.0.0", disconnect: this.#disconnect },
      "standard:events": { version: "1.0.0", on: this.#on },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: this.#signTransaction
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: this.#signAndSendTransaction
      },
      "solana:signMessage": { version: "1.0.0", signMessage: this.#signMessage }
    };
  }

  #connect = async () => {
    this.#connected = true;
    for (const fn of this.#listeners) fn({ accounts: this.accounts });
    return { accounts: this.accounts };
  };
  #disconnect = async () => {
    this.#connected = false;
    for (const fn of this.#listeners) fn({ accounts: this.accounts });
  };
  #on = (event: string, fn: (props: unknown) => void) => {
    if (event !== "change") return () => {};
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
  #signTransaction = async (...inputs: SignTxInput[]) => {
    const out = await this.#core.signTransactions(
      this.#path,
      "solana:signTransaction",
      inputs.map((i) => asBytes(i.transaction))
    );
    return out.map((signedTransaction) => ({ signedTransaction }));
  };
  // Never submits: returns the signature it would have sent.
  #signAndSendTransaction = async (...inputs: SignTxInput[]) => {
    const out = await this.#core.signTransactions(
      this.#path,
      "solana:signAndSendTransaction",
      inputs.map((i) => asBytes(i.transaction))
    );
    return out.map((tx) => ({ signature: firstSignature(tx) }));
  };
  #signMessage = async (...inputs: { account: WsAccount; message: Uint8Array }[]) => {
    const out = [];
    for (const i of inputs) {
      const signature = await this.#core.signMessage(this.#path, "solana:signMessage", asBytes(i.message));
      out.push({ signedMessage: i.message, signature });
    }
    return out;
  };
}

/** A transaction object in the shape legacy providers expect (web3.js VersionedTransaction-like). */
export class FixtureTxObject {
  constructor(private bytes: Uint8Array) {}
  serialize(): Uint8Array {
    return this.bytes.slice();
  }
}

type LegacyTx = Uint8Array | FixtureTxObject | { serialize(): Uint8Array };

function legacyBytes(tx: unknown): Uint8Array {
  if (tx instanceof Uint8Array) return tx.slice();
  if (tx && typeof tx === "object" && typeof (tx as { serialize?: unknown }).serialize === "function") {
    const out = (tx as { serialize(): unknown }).serialize();
    if (out instanceof Uint8Array) return out.slice();
  }
  throw new TypeError("fixture wallet: cannot read transaction");
}

/** Return in the same form the dApp passed in. */
function legacyReturn(input: unknown, signed: Uint8Array): LegacyTx {
  return input instanceof Uint8Array ? signed : new FixtureTxObject(signed);
}

/** Legacy injected provider, installed as window.solana and window.phantom.solana. */
export function makeLegacyProvider(core: FixtureWalletCore) {
  // web3.js PublicKey-like view of the core's current account (throwaway key or a presented address).
  let cached: { address: string; key: Readonly<{ toBase58(): string; toString(): string; toBytes(): Uint8Array }> } | null = null;
  const current = () => {
    const a = core.account;
    if (cached?.address !== a.address) {
      const pub = a.publicKey.slice();
      cached = { address: a.address, key: Object.freeze({ toBase58: () => a.address, toString: () => a.address, toBytes: () => pub.slice() }) };
    }
    return cached.key;
  };
  let connected = false;
  const provider = {
    isKelvaraFixture: true,
    name: "Kelvara Fixture (legacy)",
    get isConnected() {
      return connected;
    },
    get publicKey() {
      return connected ? current() : null;
    },
    async connect() {
      connected = true;
      return { publicKey: current() };
    },
    async disconnect() {
      connected = false;
    },
    async signTransaction(tx: LegacyTx) {
      const [signed] = await core.signTransactions("legacy", "legacy:signTransaction", [legacyBytes(tx)]);
      return legacyReturn(tx, signed!);
    },
    async signAllTransactions(txs: LegacyTx[]) {
      const signed = await core.signTransactions("legacy", "legacy:signAllTransactions", txs.map(legacyBytes));
      return txs.map((t, i) => legacyReturn(t, signed[i]!));
    },
    async signAndSendTransaction(tx: LegacyTx) {
      const [signed] = await core.signTransactions("legacy", "legacy:signAndSendTransaction", [legacyBytes(tx)]);
      return { signature: b58encode(firstSignature(signed!)), publicKey: current() };
    },
    async signMessage(message: Uint8Array) {
      const signature = await core.signMessage("legacy", "legacy:signMessage", message);
      return { signature, publicKey: current() };
    }
  };
  return provider;
}

export type LegacyProvider = ReturnType<typeof makeLegacyProvider>;
