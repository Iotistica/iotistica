import { readFileSync } from 'fs';

const profilePath = process.argv[2];
if (!profilePath) { console.error('Usage: node analyze-profile.mjs <file.cpuprofile>'); process.exit(1); }

const raw = readFileSync(profilePath, 'utf8');
const profile = JSON.parse(raw);

// nodeId -> callFrame
const nodeMap = {};
for (const node of profile.nodes) nodeMap[node.id] = node.callFrame;

// self-time sample counts
const hits = {};
for (const id of profile.samples) hits[id] = (hits[id] || 0) + 1;

// aggregate by function+file
const byFn = {};
for (const [id, count] of Object.entries(hits)) {
  const cf = nodeMap[id];
  if (!cf) continue;
  const fn   = cf.functionName || '(anon)';
  const file = (cf.url || '')
    .replace(/.*\/dist\//, 'dist/')
    .replace(/.*\/node_modules\//, 'nm/');
  const key  = `${fn}  [${file}:${cf.lineNumber}]`;
  byFn[key]  = (byFn[key] || 0) + count;
}

const total = Object.values(hits).reduce((a, b) => a + b, 0);
const durMs = (profile.endTime - profile.startTime) / 1000;

console.log(`Samples: ${total}   Duration: ${durMs.toFixed(0)} ms\n`);

// Show top 60
const sorted = Object.entries(byFn).sort((a, b) => b[1] - a[1]);

// Categorize
const isIdle   = k => /\(idle\)|\(program\)|^idle$/.test(k);
const isGC     = k => /GC|garbage|scavenge/i.test(k);
const isSystem = k => isIdle(k) || isGC(k);

let userTotal    = 0;
let gcTotal      = 0;
let idleTotal    = 0;

for (const [k, v] of sorted) {
  if      (isIdle(k))    idleTotal += v;
  else if (isGC(k))      gcTotal += v;
  else                   userTotal += v;
}

console.log(`  Idle/program : ${idleTotal}  (${(idleTotal/total*100).toFixed(1)}%)`);
console.log(`  GC           : ${gcTotal}  (${(gcTotal/total*100).toFixed(1)}%)`);
console.log(`  User code    : ${userTotal}  (${(userTotal/total*100).toFixed(1)}%)\n`);

console.log('--- TOP 60 (all) ---');
for (const [k, v] of sorted.slice(0, 60)) {
  const pct = (v / total * 100).toFixed(1).padStart(5);
  console.log(`${String(v).padStart(6)}  ${pct}%  ${k}`);
}

console.log('\n--- TOP 40 (non-idle, non-GC) ---');
const userSorted = sorted.filter(([k]) => !isSystem(k));
const userSum   = userSorted.reduce((a, [, v]) => a + v, 0);
for (const [k, v] of userSorted.slice(0, 40)) {
  const pct  = (v / total * 100).toFixed(1).padStart(5);
  const upct = (v / userSum * 100).toFixed(1).padStart(5);
  console.log(`${String(v).padStart(6)}  ${pct}% (${upct}% of work)  ${k}`);
}
