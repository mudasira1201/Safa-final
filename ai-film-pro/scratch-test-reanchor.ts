// Simulates the shotsSinceIdentityReanchor state machine across a sequence of
// shots to verify the interval logic fires at the right points.
const INTERVAL = 5;

type SimShot = { id: string; chains: boolean; hasChar: boolean };

// Scene A: 12 chained shots (all with a character) after the first (unchained, scene start).
// Scene B: starts fresh (chains=false), then 3 more chained shots.
const shots: SimShot[] = [
  { id: "a1", chains: false, hasChar: true }, // scene start
  ...Array.from({ length: 11 }, (_, i) => ({ id: `a${i + 2}`, chains: true, hasChar: true })),
  { id: "b1", chains: false, hasChar: true }, // new scene
  ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i + 2}`, chains: true, hasChar: true })),
];

let counter = 0;
const reanchoredAt: string[] = [];

for (const s of shots) {
  const isIdentityReanchor = s.chains && s.hasChar && counter >= INTERVAL;
  if (isIdentityReanchor) reanchoredAt.push(s.id);
  console.log(`${s.id}: chains=${s.chains} counter=${counter} -> reanchor=${isIdentityReanchor}`);
  counter = !s.chains || isIdentityReanchor ? 0 : counter + 1;
}

console.log("\nRe-anchored at:", reanchoredAt);

// Expectations: within scene A (11 chained shots after the unchained start),
// a reanchor should fire once counter hits 5 (at a7, the 5th chained shot),
// then again after another 5 (a12, if it exists). Scene B resets the counter
// entirely on its unchained first shot.
const expected = ["a7", "a12"];
const ok = JSON.stringify(reanchoredAt) === JSON.stringify(expected);
console.log(ok ? "ALL CHECKS PASSED" : `FAIL: expected ${JSON.stringify(expected)}`);
if (!ok) process.exit(1);
