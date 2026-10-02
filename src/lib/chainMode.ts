/**
 * Which chain this build of SAT watches, readable on the server and in the
 * browser. Solana is the default; set NEXT_PUBLIC_SAT_CHAIN=robinhood for
 * the Robinhood Chain build.
 */
export type SatChain = "solana" | "robinhood";

export const SAT_CHAIN: SatChain = process.env.NEXT_PUBLIC_SAT_CHAIN === "robinhood" ? "robinhood" : "solana";
export const ON_SOLANA = SAT_CHAIN === "solana";
export const CHAIN_NAME = ON_SOLANA ? "Solana" : "Robinhood Chain";

/**
 * The $SAT mint on Solana. Until it is set, every $SAT surface (price pill,
 * Hold SAT, buy buttons, tiers on the landing page) stays hidden; the logic
 * behind them is untouched.
 */
export const SAT_MINT = process.env.NEXT_PUBLIC_SAT_TOKEN_MINT ?? "";
export const SHOW_SAT_TOKEN = !ON_SOLANA || SAT_MINT !== "";

/** Jupiter's swap page with SOL → this token preselected. */
export const jupiterUrl = (mint: string) => `https://jup.ag/swap/SOL-${mint}`;

/** Where a token's live chart opens until the in-app Solana token page lands. */
export const tokenChartUrl = (token: string) => `https://www.geckoterminal.com/${ON_SOLANA ? "solana" : "robinhood"}/tokens/${token}`;
