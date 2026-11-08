// Program labels (E25): a name for programs ClearSign cannot decode. Not decoding, not verification.
const WORDS: Record<string, string> = { amm: "AMM", clmm: "CLMM", cpmm: "CPMM", dlmm: "DLMM", damm: "DAMM", cp: "CP", nft: "NFT", dex: "DEX", dao: "DAO", spl: "SPL", ata: "ATA", v: "V", cctp: "CCTP", okx: "OKX", pump: "Pump", fun: "fun", fi: "Fi", sdk: "SDK" };

/** "raydium_clmm" or "meteora-dlmm-v2" -> "Raydium CLMM", "Meteora DLMM v2". */
export function humanizeSlug(slug: string): string {
  return slug
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (/^v\d+$/i.test(w) ? w.toLowerCase() : WORDS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
