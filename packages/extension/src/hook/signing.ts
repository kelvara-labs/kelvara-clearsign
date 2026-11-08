// Names that can open a wallet signing prompt. Anything matching that is not a method we
// can analyze (transaction bytes) is rejected fail-closed instead of reaching the wallet.
const SIGNING_NAME = /sign|send|transact|submit|approve|authori[sz]e|permit|encrypt|decrypt/i;

export const isSigningName = (name: unknown): name is string => typeof name === "string" && SIGNING_NAME.test(name);

/** Wallet Standard `standard:*` features carry no signing; everything else is judged by name. */
export const isSigningFeature = (key: string): boolean => !key.startsWith("standard:") && isSigningName(key);
