'use strict';

// Self-check / debug entry: `node src/cli.js [conversationId]`.
// Prints what the analyzer sees so the UI layer can be trusted.

const {
  findActiveConversation,
  listConversations,
  readTrajectory,
  learnFloor,
  brainAttachments,
} = require('./reader');
const { buildBreakdown } = require('./analyzer');

function fmt(n) {
  if (n == null) return 'n/a';
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function findCompactions(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].contextTotal;
    const cur = samples[i].contextTotal;
    if (cur < prev * 0.5) out.push({ step: samples[i].idx, from: prev, to: cur });
  }
  return out;
}

function main() {
  const argId = process.argv[2];
  const conv = argId ? { conversation_id: argId, title: '(explicit)' } : findActiveConversation();

  if (!conv) {
    console.log('no conversations found under ~/.gemini/antigravity');
    return;
  }

  const traj = readTrajectory(conv.conversation_id);
  if (!traj) {
    console.log('trajectory not readable for', conv.conversation_id);
    return;
  }

  const last = traj.samples.at(-1);
  const pct = traj.limit && last ? (last.contextTotal / traj.limit) * 100 : null;

  console.log('conversation :', conv.title);
  console.log('id           :', traj.id);
  console.log('model        :', traj.model);
  console.log('window limit :', fmt(traj.limit));
  console.log('generations  :', traj.samples.length);
  console.log('context now  :', fmt(last && last.contextTotal), pct != null ? `(${pct.toFixed(1)}%)` : '');
  console.log('first sample :', fmt(traj.samples[0] && traj.samples[0].contextTotal));
  console.log('peak         :', fmt(Math.max(...traj.samples.map((s) => s.contextTotal))));
  console.log('compactions  :', JSON.stringify(findCompactions(traj.samples)));
  console.log('prompt bytes :', traj.latestPrompt.length);
  console.log('total convs  :', listConversations().length);

  const floorHint = learnFloor();
  console.log('learned floor:', floorHint);
  const breakdown = buildBreakdown(traj, brainAttachments(traj.id), { floorHint });
  if (breakdown.empty) {
    console.log('\nbreakdown    :', breakdown.reason);
    return;
  }
  console.log('\n--- breakdown (measured total %s, scaled=%s) ---', fmt(breakdown.total), breakdown.scaled);
  for (const c of breakdown.categories) {
    console.log(`  ${c.label.padEnd(18)} ${fmt(c.tokens).padStart(8)}  ${c.percent.toFixed(1)}%`);
  }
  const sum = breakdown.categories.reduce((a, c) => a + c.tokens, 0);
  console.log('  %s %s  (sum check)', 'sum'.padEnd(18), fmt(sum).padStart(8), sum === breakdown.total ? 'OK' : 'MISMATCH');
}

main();
