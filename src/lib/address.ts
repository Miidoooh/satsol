/**
 * Token addresses across chains. EVM addresses are 0x-hex and case-insensitive;
 * Solana mint addresses are base58 and case-sensitive, so always keep the
 * original spelling and compare through `addrKey`.
 */

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isEvmAddress = (s: string) => EVM.test(s);
export const isSolanaAddress = (s: string) => SOLANA.test(s);
export const isTokenAddress = (s: string) => EVM.test(s) || SOLANA.test(s);

/** A map key for an address. Lowercasing is safe for lookups: two real Solana mints never differ only by case. */
export const addrKey = (s: string) => s.toLowerCase();

export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && addrKey(a) === addrKey(b);

/** Any token address inside free text: EVM hex, or a Solana mint (base58, 32 to 44 characters). */
export const ADDRESS_IN_TEXT = /0x[a-fA-F0-9]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
