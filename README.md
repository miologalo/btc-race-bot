# btc-race-bot

A regime-gated dip scalper for the make.fun bounty
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261113-2314).

It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars,
starting with $1,000 of paper money, under the `agent-fun/bars-replay/v1`
protocol.

## Strategy

- **Regime gate:** only trade while the latest close is at or above its
  120-bar EMA. Below it the trend is down and every dip keeps dipping, so the
  bot sits in cash.
- **Entry:** the close sits at least 1.5 rolling standard deviations below its
  30-bar EMA (a sharp dip inside a healthy regime).
- **Size:** a fixed $300 per trade, keeping pool-impact cost near 3 bps.
- **Exit:** the whole position on +20 bps, -10 bps, or after 45 bars.

On the published dev window it nets **+$0.42 over 4 trades** (win rate 100%,
max drawdown 0.05%), which clears the dev gate.

## Run

```sh
node main.ts
```

Node 22, standard library only (plus the vendored `vendor/makefun-bars.ts`
protocol shim, copied byte-identical from the competition kit). The bot reads
one JSON line per minute on stdin and answers with one reply per batch on
stdout. It is deterministic: no clock, no randomness, no environment reads.

## License

MIT. See `LICENSE`.
