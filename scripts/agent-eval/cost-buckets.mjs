#!/usr/bin/env node
// Billed-token BUCKETS of a `claude -p --output-format stream-json` run (CG-39).
//
// "Total tokens" hides the cost story: in an agent loop 80–95% of the summed
// tokens are cheap cache READS, and the bill is decided by what is written to
// the cache each turn (new tool results) and by output. So the four buckets —
// input / cache_creation (5m · 1h) / cache_read / output — are reported
// separately, each priced, and the write+output share is the number to compare
// between arms. See docs/design/large-repo-simple-question-cost.md §2.
//
// KNOWN GOTCHA (found 2026-09-02 on a real UnrealEngine run): the per-message
// `usage.output_tokens` under-reports billed output/thinking tokens when
// thinking display is "omitted" (the Sonnet 5 / Fable 5 default) — a 4-turn run
// summed to 10 output tokens while `total_cost_usd` implied ~3,700 were billed.
// `estimated_tokens` in system/thinking_tokens events are progress-UI numbers,
// not billing. So the raw output bucket is printed as UNRELIABLE and the number
// to trust is the reconciled one:
//   output_reconciled = (total_cost_usd - cost(input + write5m + write1h + read)) / output price
//
// Usage: node cost-buckets.mjs <run.jsonl> [<run2.jsonl> ...]
//   MODEL=sonnet|opus|haiku   price table (default sonnet — the eval floor model)
//   CG_PRICES='{"input":2,"write5m":2.5,"write1h":4,"read":0.2,"output":10}'
//                             explicit $/MTok table, overrides MODEL
// Also imported by parse-run.mjs (bucketsOf / formatBucketsBrief) so every A/B
// run prints the same breakdown.
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

/** $/MTok. Cache write = 1.25x (5m) / 2x (1h) input; cache read = 0.1x input. */
export const PRICES = {
  // Verified against `total_cost_usd` on real runs (reconstruction error <1%).
  sonnet: { input: 2.0, write5m: 2.5, write1h: 4.0, read: 0.2, output: 10.0 },
  // Standard multipliers over the list input/output price; not yet verified
  // against a real run — the eval policy is Sonnet on both arms.
  opus: { input: 5.0, write5m: 6.25, write1h: 10.0, read: 0.5, output: 25.0 },
  haiku: { input: 1.0, write5m: 1.25, write1h: 2.0, read: 0.1, output: 5.0 },
};

export function resolvePrices(model = process.env.MODEL) {
  if (process.env.CG_PRICES) {
    const p = JSON.parse(process.env.CG_PRICES);
    for (const k of Object.keys(PRICES.sonnet)) {
      if (typeof p[k] !== 'number') throw new Error(`CG_PRICES is missing "${k}"`);
    }
    return { ...p, label: 'CG_PRICES' };
  }
  const key = (model || 'sonnet').toLowerCase();
  const found = Object.keys(PRICES).find((k) => key.includes(k));
  if (!found) throw new Error(`no price table for MODEL=${model}; set CG_PRICES`);
  return { ...PRICES[found], label: found };
}

/** Parse one or more stream-json files into a flat event list. */
export function readEvents(files) {
  const events = [];
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* partial line */ }
    }
  }
  return events;
}

/**
 * Split a run's events into billed buckets. Dedupes assistant usage by
 * message.id (Claude Code emits one event per content block, all carrying the
 * same usage). `reported` is the sum of every result's total_cost_usd.
 */
export function bucketsOf(events, prices = resolvePrices()) {
  const seen = new Set();
  const tok = { input: 0, write5m: 0, write1h: 0, read: 0, outputRaw: 0 };
  const tools = {};
  const resultChars = {};
  let turns = 0;
  let reported = null;
  for (const ev of events) {
    if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') {
      reported = (reported ?? 0) + ev.total_cost_usd;
    }
    if (ev.type === 'user') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content
          : (c.content || []).map((x) => x.text || '').join('');
        resultChars[c.tool_use_id] = text.length;
      }
    }
    if (ev.type !== 'assistant' || !ev.message) continue;
    for (const c of ev.message.content || []) {
      if (c.type === 'tool_use') (tools[c.name] ||= []).push(c.id);
    }
    const id = ev.message.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    turns++;
    const u = ev.message.usage || {};
    const cc = u.cache_creation || {};
    const w1h = cc.ephemeral_1h_input_tokens || 0;
    const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
    tok.input += u.input_tokens || 0;
    tok.write5m += w5m;
    tok.write1h += w1h;
    tok.read += u.cache_read_input_tokens || 0;
    tok.outputRaw += u.output_tokens || 0;
  }
  const cost = {
    input: tok.input * prices.input / 1e6,
    write5m: tok.write5m * prices.write5m / 1e6,
    write1h: tok.write1h * prices.write1h / 1e6,
    read: tok.read * prices.read / 1e6,
    outputRaw: tok.outputRaw * prices.output / 1e6,
  };
  const costKnown = cost.input + cost.write5m + cost.write1h + cost.read;
  // Reconciled output: what the reported bill says was spent beyond the three
  // input-side buckets. Null when there is no result event to reconcile against.
  const outputCost = reported != null ? Math.max(0, reported - costKnown) : null;
  const output = outputCost != null ? Math.round(outputCost * 1e6 / prices.output) : null;
  const total = costKnown + (outputCost ?? cost.outputRaw);
  const toolStats = Object.fromEntries(Object.entries(tools).map(([name, ids]) => [
    name, { calls: ids.length, chars: ids.reduce((a, id) => a + (resultChars[id] || 0), 0) },
  ]));
  return {
    prices: prices.label,
    turns,
    reported,
    tokens: { ...tok, output },
    cost: {
      ...cost,
      output: outputCost,
      known: costKnown,
      total,
      writeAndOutput: cost.write5m + cost.write1h + (outputCost ?? cost.outputRaw),
    },
    tools: toolStats,
  };
}

const int = (x) => Math.round(x).toLocaleString('en-US');
const usd = (x) => `$${x.toFixed(3)}`;

/** Two summary lines, as printed under a run by parse-run.mjs. */
export function formatBucketsBrief(b, indent = '  ') {
  const t = b.tokens; const c = b.cost;
  const out = t.output != null
    ? `${int(t.output)} (reconciled from cost; raw field ${int(t.outputRaw)})`
    : `${int(t.outputRaw)} (raw field — UNRELIABLE, no result event to reconcile)`;
  const pct = c.total > 0 ? ` (${Math.round(100 * (c.write5m + c.write1h) / c.total)}%)` : '';
  const reported = b.reported != null ? ` (reported ${usd(b.reported)})` : '';
  return [
    `${indent}billed buckets (${b.prices}): input ${int(t.input)} | cache write 5m ${int(t.write5m)} · 1h ${int(t.write1h)} | cache read ${int(t.read)} | output ${out}`,
    `${indent}bucket cost: write ${usd(c.write5m + c.write1h)}${pct} · read ${usd(c.read)} · output ${usd(c.output ?? c.outputRaw)} · input ${usd(c.input)} -> write+output ${usd(c.writeAndOutput)} of ${usd(c.total)}${reported}`,
  ].join('\n');
}

/** The full block the CLI prints per file. */
export function formatBuckets(b, indent = '  ') {
  const t = b.tokens; const c = b.cost;
  const share = ($) => (c.total > 0 ? String(Math.round(100 * $ / c.total)).padStart(3) + '% of cost' : '');
  const row = (label, n, $, note = '') =>
    `${indent}${label.padEnd(24)} ${int(n).padStart(10)} tok  ${usd($).padStart(8)}  ${share($)}${note}`;
  const lines = [
    row('input', t.input, c.input),
    row('cache write (5m)', t.write5m, c.write5m),
    row('cache write (1h)', t.write1h, c.write1h),
    row('cache read', t.read, c.read),
    `${indent}${'output (raw field)'.padEnd(24)} ${int(t.outputRaw).padStart(10)} tok  ${usd(c.outputRaw).padStart(8)}  (UNRELIABLE — see header comment)`,
  ];
  if (t.output != null) lines.push(row('output (from cost gap)', t.output, c.output, '  <- trust this one'));
  lines.push(`${indent}${'write + output'.padEnd(24)} ${''.padStart(10)}      ${usd(c.writeAndOutput).padStart(8)}  the arm-comparable number`);
  for (const [name, s] of Object.entries(b.tools)) {
    lines.push(`${indent}tool ${name.padEnd(35)} calls=${s.calls}  result chars=${int(s.chars)}`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: cost-buckets.mjs <run.jsonl> [...]   (MODEL=sonnet|opus|haiku, or CG_PRICES=json)');
    process.exit(1);
  }
  const prices = resolvePrices();
  for (const file of files) {
    const b = bucketsOf(readEvents([file]), prices);
    const tokens = b.tokens.input + b.tokens.write5m + b.tokens.write1h + b.tokens.read + (b.tokens.output ?? b.tokens.outputRaw);
    console.log(`\n== ${file}  turns=${b.turns}  tokens(est)=${int(tokens)}  reported=${b.reported != null ? usd(b.reported) : '?'}  prices=${b.prices}`);
    console.log(formatBuckets(b));
  }
}
