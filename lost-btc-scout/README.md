# Crypto Scout (formerly Lost BTC Scout)

A standalone, mobile-friendly, read-only public-address explorer, independent from Master Brain. No wallet, private key, seed phrase, signing, or initial capital is required.

## Multi-chain support in `multichain.html`
- Bitcoin (BTC): balance and transaction count from the public mempool.space API.
- EVM native assets: Ethereum (ETH), BNB Smart Chain (BNB), Polygon (POL), Arbitrum One (ETH), Optimism (ETH), Base (ETH), and Avalanche C-Chain (AVAX). Reads native balance, transaction nonce, and latest block from public JSON-RPC endpoints.
- Offers links to independent block explorers.

## Limitations
- It does **not** prove that any address is abandoned, ownerless, or available to claim. Age, low activity, and high balance are not proof of abandonment or permission to access funds.
- It does not scan the entire blockchain or search every wallet automatically. It checks one address at a time.
- The current multi-chain page does not index ERC-20/BEP-20 tokens or NFTs. A zero native balance does not imply no token assets.
- Public APIs/RPC endpoints may be rate-limited, unavailable, or block browser requests. Results should be verified in an independent explorer.
- Never enter seed phrases or private keys. The app cannot recover funds without the legitimate signing key and does not guarantee income.

## Free static hosting
GitHub Pages may host this as a static site if Pages is enabled and configured from the branch containing these files. The multi-chain page is `lost-btc-scout/multichain.html`. Deployment is not considered live until the published URL is tested.

## Data sources
- Bitcoin: https://mempool.space/docs/api
- EVM: public JSON-RPC endpoints configured in `multichain.html`
