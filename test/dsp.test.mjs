// Headless checks for the pure DSP modules: `node test/dsp.test.mjs`.
// The browser test bench (test.html) runs the same checks plus audio ones.
import { runDspChecks } from './checks.js';

let failed = 0;
for (const r of runDspChecks()) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  if (!r.pass) failed++;
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
