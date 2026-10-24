# Lost BTC Scout

A tiny, standalone, mobile-friendly, read-only Bitcoin public-address explorer. It is separate from Master Brain and requires no wallet, private key, seed phrase, or transaction signing.

## What it does
- Queries public address data from the mempool.space API.
- Shows reported balance, transaction count, latest available confirmed transaction time, and unspent outputs (UTXOs).
- Provides links to independently inspect an address and its recent transactions.
- Works as a static web page on mobile browsers.

## Important limitations
- Address inactivity, age, or balance does **not** prove that an address is abandoned, ownerless, or available to claim.
- This initial version checks one address at a time. It does not crawl the entire Bitcoin blockchain or identify private keys.
- It cannot guarantee profit or recover funds from an address without the legitimate signing key.
- Public APIs can rate-limit requests, be unavailable, or return incomplete data.
- Do not enter private keys or seed phrases. The app does not need them.

## Run locally
Open `index.html` in a modern browser. Some browsers restrict cross-origin requests when opened as a local file; if so, use a simple local static server or host the page.

## Free static hosting
The repository can host this as a static page with GitHub Pages if Pages is enabled in repository settings and configured to deploy from the branch/folder containing this file. For example, deploying the repository root makes the page available at `/lost-btc-scout/`. Hosting and API availability are subject to provider terms and limits.

## Data source
- mempool.space public API: https://mempool.space/docs/api
