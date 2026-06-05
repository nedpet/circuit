/**
 * Quine-McCluskey Boolean Minimization Algorithm
 *
 * Usage:
 *   const result = quineMcCluskey(minterms, numVars, dontCares);
 *   console.log(result.expression);
 */

// ─── Step 1: Group minterms by number of 1-bits ───────────────────────────────

function countOnes(n) {
  let count = 0;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}

function groupByOnes(minterms, numVars) {
  const groups = {};
  for (const m of minterms) {
    const ones = countOnes(m);
    if (!groups[ones]) groups[ones] = [];
    groups[ones].push({ minterms: [m], mask: 0 });
  }
  return groups;
}

// ─── Step 2: Combine adjacent groups ──────────────────────────────────────────

/**
 * Two implicants can combine if:
 *  - Their masks are identical (same bits already merged)
 *  - Their minterm values differ in exactly one bit (that bit is not masked)
 */
function canCombine(a, b) {
  if (a.mask !== b.mask) return false;
  const diff = (a.minterms[0] & ~a.mask) ^ (b.minterms[0] & ~b.mask);
  return diff !== 0 && (diff & (diff - 1)) === 0; // exactly one bit differs
}

function combine(a, b) {
  const diff = (a.minterms[0] & ~a.mask) ^ (b.minterms[0] & ~b.mask);
  return {
    minterms: [...new Set([...a.minterms, ...b.minterms])],
    mask: a.mask | diff,
  };
}

function generatePrimeImplicants(minterms, numVars) {
  let currentGroups = groupByOnes(minterms, numVars);
  const primeImplicants = [];

  while (true) {
    const nextGroups = {};
    const used = new Set();

    const keys = Object.keys(currentGroups).map(Number).sort((a, b) => a - b);

    for (let i = 0; i < keys.length - 1; i++) {
      const groupA = currentGroups[keys[i]];
      const groupB = currentGroups[keys[i + 1]];

      for (const a of groupA) {
        for (const b of groupB) {
          if (canCombine(a, b)) {
            const combined = combine(a, b);
            const key = keys[i]; // place in lower group bucket
            if (!nextGroups[key]) nextGroups[key] = [];

            // Avoid duplicate implicants in next round
            const isDup = nextGroups[key].some(
              (x) =>
                x.mask === combined.mask &&
                x.minterms[0] === combined.minterms[0]
            );
            if (!isDup) nextGroups[key].push(combined);

            used.add(JSON.stringify(a));
            used.add(JSON.stringify(b));
          }
        }
      }
    }

    // Any implicant not used in a combination is a prime implicant
    for (const group of Object.values(currentGroups)) {
      for (const impl of group) {
        if (!used.has(JSON.stringify(impl))) {
          primeImplicants.push(impl);
        }
      }
    }

    if (Object.keys(nextGroups).length === 0) break;
    currentGroups = nextGroups;
  }

  return primeImplicants;
}

// ─── Step 3: Build the prime implicant chart ──────────────────────────────────

function buildCoverageChart(primeImplicants, requiredMinterms) {
  // For each required minterm, which prime implicants cover it?
  const chart = {};
  for (const m of requiredMinterms) {
    chart[m] = primeImplicants
      .map((pi, idx) => (pi.minterms.includes(m) ? idx : -1))
      .filter((idx) => idx !== -1);
  }
  return chart;
}

// ─── Step 4: Select essential prime implicants ────────────────────────────────

function selectCover(primeImplicants, requiredMinterms) {
  const chart = buildCoverageChart(primeImplicants, requiredMinterms);
  const selected = new Set();
  const covered = new Set();

  // Find essential prime implicants (columns covered by only one row)
  for (const [minterm, covering] of Object.entries(chart)) {
    if (covering.length === 1) {
      const essentialIdx = covering[0];
      if (!selected.has(essentialIdx)) {
        selected.add(essentialIdx);
        for (const m of primeImplicants[essentialIdx].minterms) {
          covered.add(m);
        }
      }
    }
  }

  // Cover remaining minterms greedily (pick the PI covering the most uncovered)
  const remaining = requiredMinterms.filter((m) => !covered.has(m));
  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestCount = -1;

    for (let i = 0; i < primeImplicants.length; i++) {
      if (selected.has(i)) continue;
      const newlyCovered = primeImplicants[i].minterms.filter((m) =>
        remaining.includes(m)
      ).length;
      if (newlyCovered > bestCount) {
        bestCount = newlyCovered;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.add(bestIdx);
    for (const m of primeImplicants[bestIdx].minterms) {
      const idx = remaining.indexOf(m);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  }

  return [...selected].map((i) => primeImplicants[i]);
}

// ─── Step 5: Format the result as a Boolean expression ────────────────────────

function implicantToTerm(implicant, numVars, varNames) {
  console.log(varNames + " " + numVars);
  const representative = implicant.minterms[0];
  const mask = implicant.mask;
  let term = "";

  for (let i = numVars - 1; i >= 0; i--) {
    const bitPos = numVars - 1 - i;
    if (mask & (1 << i)) continue; // this bit is a don't-care (merged away)
    const bit = (representative >> i) & 1;
    term += bit === 1 ? varNames[bitPos] : varNames[bitPos] + "'";
  }

  return term || "1"; // all variables merged → constant 1
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * @param {number[]} minterms     - Indices where the function is 1
 * @param {number}   numVars      - Number of input variables
 * @param {string[]} varNames     - Variable names
 * @param {number[]} [dontCares]  - Indices where the output is irrelevant
 * @returns {{ expression: string, primeImplicants: object[], selectedTerms: object[] }}
 */
function quineMcCluskey(minterms, numVars, varNames, dontCares = []) {
  if (minterms.length === 0) return { expression: "0", primeImplicants: [], selectedTerms: [] };

  const allOnes = [...new Set([...minterms, ...dontCares])];
  const allOnesCount = Math.pow(2, numVars);

  if (minterms.length === allOnesCount) return { expression: "1", primeImplicants: [], selectedTerms: [] };

  // Generate prime implicants from minterms + don't-cares combined
  const primeImplicants = generatePrimeImplicants(allOnes, numVars);

  // But only cover the required minterms (not don't-cares) in the chart
  const selectedTerms = selectCover(primeImplicants, minterms);

  varNames.reverse();
  const terms = selectedTerms.map((pi) => implicantToTerm(pi, numVars, varNames));
  const expression = terms.join(" + ") || "0";

  return { expression, primeImplicants, selectedTerms };
}
