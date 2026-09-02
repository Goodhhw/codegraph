// Usage: node cost-breakdown.mjs <run.jsonl> [<run2.jsonl> ...]
// Splits a `claude -p --output-format stream-json` run into billed token
// buckets and per-bucket dollar share (Sonnet 5 list prices), deduped by
// assistant message.id (one event per content block, same usage).
//
// KNOWN GOTCHA (found 2026-09-02 on a real UnrealEngine run): per-message
// `usage.output_tokens` under-reports actual billed output/thinking tokens
// when thinking display is "omitted" (the Sonnet 5 / Fable 5 default) — a
// 4-turn run showed output_tokens summing to 10 while total_cost_usd implied
// ~3,700 output-priced tokens were actually billed. `estimated_tokens` in
// `system`/`thinking_tokens` events are progress-UI numbers, not billing —
// don't trust them either. So: report the raw (unreliable) output bucket AND
// a reconciled "output (from cost gap)" bucket computed as
// (reported total_cost_usd - sum of the other three buckets' cost) / output
// price. Treat the reconciled number as the real output+thinking spend.
import fs from 'node:fs';
const PRICE = { input: 2.0, write5m: 2.5, write1h: 4.0, read: 0.2, output: 10.0 }; // $/MTok, Sonnet 5

for (const file of process.argv.slice(2)) {
  const seen = new Set();
  const b = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
  const tools = {};
  let turns = 0, toolResultChars = {};
  let reported = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') reported = ev.total_cost_usd;
    if (ev.type === 'user') {
      for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content
          : (c.content || []).map(x => x.text || '').join('');
        toolResultChars[c.tool_use_id] = text.length;
      }
    }
    if (ev.type !== 'assistant' || !ev.message) continue;
    for (const c of ev.message.content || []) {
      if (c.type === 'tool_use') { tools[c.name] = tools[c.name] || []; tools[c.name].push(c.id); }
    }
    const id = ev.message.id;
    if (!id || seen.has(id)) continue;
    seen.add(id); turns++;
    const u = ev.message.usage || {};
    const cc = u.cache_creation || {};
    const w1h = cc.ephemeral_1h_input_tokens || 0;
    const w5m = cc.ephemeral_5m_input_tokens ?? ((u.cache_creation_input_tokens || 0) - w1h);
    b.input += u.input_tokens || 0; b.write5m += w5m; b.write1h += w1h;
    b.read += u.cache_read_input_tokens || 0; b.output += u.output_tokens || 0;
  }
  const cost = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v * PRICE[k] / 1e6]));
  const knownCost = cost.input + cost.write5m + cost.write1h + cost.read; // exclude raw (unreliable) output
  const outputCostReconciled = reported != null ? Math.max(0, reported - knownCost) : null;
  const outputTokReconciled = outputCostReconciled != null ? outputCostReconciled * 1e6 / PRICE.output : null;
  const total = knownCost + (outputCostReconciled ?? cost.output);
  const tokens = b.input + b.write5m + b.write1h + b.read + (outputTokReconciled ?? b.output);

  console.log(`\n== ${file}  turns=${turns}  tokens(est)=${Math.round(tokens).toLocaleString()}  reported=$${reported ?? '?'}`);
  for (const k of ['input', 'write5m', 'write1h', 'read']) {
    console.log(`  ${k.padEnd(20)} ${String(b[k]).padStart(10)} tok  $${cost[k].toFixed(3).padStart(6)}  ${(100 * cost[k] / total).toFixed(0).padStart(3)}% of cost`);
  }
  console.log(`  output (raw field)  ${String(b.output).padStart(10)} tok  $${cost.output.toFixed(3).padStart(6)}  (UNRELIABLE — see header comment)`);
  if (outputCostReconciled != null) {
    console.log(`  output (from cost gap) ${String(Math.round(outputTokReconciled)).padStart(7)} tok  $${outputCostReconciled.toFixed(3).padStart(6)}  ${(100 * outputCostReconciled / total).toFixed(0).padStart(3)}% of cost  <- trust this one`);
  }
  for (const [name, ids] of Object.entries(tools)) {
    const chars = ids.reduce((a, id) => a + (toolResultChars[id] || 0), 0);
    console.log(`  tool ${name.padEnd(35)} calls=${ids.length}  result chars=${chars.toLocaleString()}`);
  }
}
