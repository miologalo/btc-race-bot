// Regime-gated dip scalper for the BTC 24h race (bars-replay/v1, Node 22).
//
// Idea: cbBTC on a 1-minute replay is a near-random walk with a downward drift,
// so being long through a downtrend just bleeds. This bot stays in cash unless
// the tape is healthy, then buys sharp dips and exits fast:
//
// - Regime: trade only while the latest close is at or above its 120-bar EMA.
//   Below it the trend is down and every dip keeps dipping, so sit in cash.
// - Entry: the close sits at least 1.5 rolling standard deviations below its
//   30-bar EMA (z <= -1.5), i.e. a sharp dip inside a healthy regime, and the
//   trade's own pool impact at the latest close depth is at most 10 bps, so a
//   thin pool never eats the edge the dip is supposed to give.
// - Size: a fixed $300 of the $1,000 paper capital per trade (small size keeps
//   the pool-impact cost near 3 bps instead of ~10 bps at full size).
// - Exit: the whole position on +20 bps (take profit), -10 bps (stop), or after
//   45 bars, whichever comes first. A full round trip then costs ~14 bps, so a
//   20 bps winner clears it and a loser is cut at 10 bps plus costs.
// - One position at a time, at most one order per reply, max slippage 100 bps.
//
// Everything is deterministic: EMAs and the rolling deviation are pure functions
// of the closes seen so far, no clock, no randomness, no environment reads.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SPAN = 30; // fast EMA span (bars)
const LONG_SPAN = 120; // regime EMA span (bars)
const Z_IN = -1.5; // entry z-score (close vs fast EMA, in rolling stdevs)
const SIZE_USDC = 300n * 1_000_000n; // fixed notional per trade, quote units
const TP_BPS = 20; // take profit, bps above the entry close
const SL_BPS = 10; // stop loss, bps below the entry close
const MAX_HOLD = 45; // max bars to hold a position
const MAX_SLIPPAGE_BPS = 100;
const MAX_IMPACT_BPS = 10; // skip an entry whose own pool impact would cost more than this

/** EMA that seeds as the mean of its first span of closes, then updates by 2 / (span + 1) of the way to each new close. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

const fast: Ema = { span: SPAN, warm: [], value: null };
const regime: Ema = { span: LONG_SPAN, warm: [], value: null };
const devs: number[] = []; // recent (close - fast EMA) deviations, at most SPAN long
let entryClose: number | null = null; // close of the bar the position was decided on
let holdAge = 0; // bars held (counts the fill bar as 1)
let pendingEntry: number | null = null; // entry close stored at buy decision, confirmed on fill

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c); // price in 1e-5 USDC per cbBTC; the scale cancels in ratios

    // Confirm fills from the previous batch's orders.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL) continue;
      if (f.status === 'filled' && f.side === 'buy') {
        entryClose = pendingEntry !== null ? pendingEntry : close;
        holdAge = 0;
        pendingEntry = null;
      } else if (f.status === 'filled' && f.side === 'sell') {
        entryClose = null;
        holdAge = 0;
        pendingEntry = null;
      } else if (f.status === 'rejected' && f.side === 'buy') {
        pendingEntry = null;
      }
    }

    // Indicators read every bar, warm-up included.
    step(fast, close);
    step(regime, close);
    if (fast.value !== null) {
      devs.push(close - fast.value);
      if (devs.length > SPAN) devs.shift();
    }

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      if (entryClose === null) {
        // Safety net: a position whose entry was not recorded; anchor exits
        // at the current close so it can still leave on the clock.
        entryClose = close;
        holdAge = 0;
      }
      holdAge += 1;
      if (
        close >= entryClose * (1 + TP_BPS / 10000) ||
        close <= entryClose * (1 - SL_BPS / 10000) ||
        holdAge >= MAX_HOLD
      ) {
        entryClose = null;
        holdAge = 0;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: only enter in a healthy regime on a sharp dip.
    if (fast.value === null || regime.value === null) return [];
    if (devs.length < 6) return [];
    const sd = Math.sqrt(devs.reduce((a, d) => a + d * d, 0) / devs.length);
    const z = sd > 0 ? (close - fast.value) / sd : 0;
    if (z <= Z_IN && close >= regime.value) {
      const notional = SIZE_USDC < state.cash ? SIZE_USDC : state.cash;
      // Skip the entry when the pool is too thin for the size: the fill's own
      // impact would eat the edge the dip is supposed to give.
      const impact = state.impactBps(SYMBOL, notional);
      if (impact !== null && impact > BigInt(MAX_IMPACT_BPS)) return [];
      if (notional >= 1_000_000n) {
        pendingEntry = close;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }
    return [];
  },
});
