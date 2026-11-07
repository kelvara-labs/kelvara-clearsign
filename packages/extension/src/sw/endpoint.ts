// RPC endpoint per chain. Helius only for mainnet and devnet; localnet for local tests.
// The key comes from options storage and is never logged: use redactUrl() before printing.
import type { Chain } from "../shared/protocol.js";

export type Network = "mainnet" | "devnet" | "localnet";

export const HELIUS_RPC: Record<"mainnet" | "devnet", string> = {
  mainnet: "https://mainnet.helius-rpc.com/",
  devnet: "https://devnet.helius-rpc.com/"
};
export const LOCALNET_RPC = "http://localhost:8899";

/** Wallet Standard chain wins; legacy providers carry no chain, so use the configured network. */
export function networkFor(chain: Chain | null, configured: Network): Network | null {
  if (chain === null) return configured;
  if (chain === "solana:mainnet") return "mainnet";
  if (chain === "solana:devnet") return "devnet";
  if (chain === "solana:localnet") return "localnet";
  return null; // testnet: no Helius endpoint, so we cannot analyze it
}

export type Endpoint = { ok: true; network: Network; url: string } | { ok: false; reason: string };

export function pickEndpoint(chain: Chain | null, configured: Network, heliusKey: string | undefined): Endpoint {
  const network = networkFor(chain, configured);
  if (!network) return { ok: false, reason: `unsupported chain ${chain}` };
  if (network === "localnet") return { ok: true, network, url: LOCALNET_RPC };
  const key = (heliusKey ?? "").trim();
  if (!key) return { ok: false, reason: "no Helius API key set: request held and blocked. Add a key in Kelvara SignGuard options" };
  return { ok: true, network, url: `${HELIUS_RPC[network]}?api-key=${encodeURIComponent(key)}` };
}

export function redactUrl(s: string): string {
  return s.replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");
}
