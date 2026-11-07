// Signed, exact amount text for reports: lamports as SOL, token base units with their decimals.

export const lamportsText = (l: bigint): string => {
  const neg = l < 0n;
  const a = neg ? -l : l;
  const whole = a / 1_000_000_000n;
  const frac = (a % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : "+"}${whole}${frac ? "." + frac : ""} SOL`;
};

export const tokenText = (amount: bigint, decimals: number | null): string => {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  if (decimals === null || decimals === 0) return `${neg ? "-" : "+"}${a}${decimals === null ? " (raw units)" : ""}`;
  const p = 10n ** BigInt(decimals);
  const frac = (a % p).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : "+"}${a / p}${frac ? "." + frac : ""}`;
};

/** Unsigned form of the above ("1.5 SOL", "50000"). */
export const unsigned = (text: string): string => text.replace(/^[+-]/, "");
