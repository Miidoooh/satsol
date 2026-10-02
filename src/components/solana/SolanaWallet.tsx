"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Solana wallets through the Wallet Standard: Phantom, Solflare, Backpack and
 * any other standard wallet show up without per-wallet code. The connection
 * here is only used by the wallet UI; SAT's server builds and broadcasts trades.
 */
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={PUBLIC_RPC}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export function SolanaConnectButton() {
  return <WalletMultiButton className="sol-connect" />;
}
