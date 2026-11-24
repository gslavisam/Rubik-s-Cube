import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const htmlPath = path.resolve(process.cwd(), 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const startMarker = '// === CUBE_SOLVER_START ===';
const endMarker = '// === CUBE_SOLVER_END ===';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);

assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, 'Solver markers must exist in index.html');

const solverSource = html.slice(startIdx + startMarker.length, endIdx);

const context = vm.createContext({
  Math,
  Error,
  Object,
  Array,
  Number,
  String,
  Boolean
});

vm.runInContext(
  solverSource +
    '\nthis.__exports = { MOVE_DEFS, createSolvedState, cloneState, applyMoveToState, isStateSolved, generateScramble, solveCubeLBL, invertMove, compressMoves };',
  context
);

const {
  createSolvedState,
  cloneState,
  applyMoveToState,
  isStateSolved,
  generateScramble,
  solveCubeLBL,
  invertMove
} = context.__exports;

test('initial state has 27 cubies and is solved', () => {
  const s = createSolvedState();
  assert.equal(s.length, 27);
  assert.equal(isStateSolved(s), true);
});

test('every outer move is order 4 and move + inverse returns to solved', () => {
  const faces = ['U', 'D', 'L', 'R', 'F', 'B'];
  for (const f of faces) {
    const s = createSolvedState();
    applyMoveToState(s, f);
    assert.equal(isStateSolved(s), false, `${f} should unsolve cube`);
    applyMoveToState(s, invertMove(f));
    assert.equal(isStateSolved(s), true, `${f} + ${invertMove(f)} should re-solve cube`);

    const s4 = createSolvedState();
    for (let i = 0; i < 4; i++) applyMoveToState(s4, f);
    assert.equal(isStateSolved(s4), true, `${f} x 4 should return to solved`);
  }
});

test('scramble generates 22 non-redundant moves', () => {
  const scramble = generateScramble(22);
  assert.equal(scramble.length, 22);
  for (let i = 1; i < scramble.length; i++) {
    assert.notEqual(scramble[i][0], scramble[i - 1][0], 'No consecutive same-face moves');
  }
});

test('7-step LBL solver solves 150 randomized 22-move scrambles', () => {
  for (let trial = 0; trial < 150; trial++) {
    const cube = createSolvedState();
    const scramble = generateScramble(22);
    for (const m of scramble) {
      applyMoveToState(cube, m);
    }

    const phases = solveCubeLBL(cube);
    const verifyCube = cloneState(cube);
    let totalMoves = 0;
    for (const ph of phases) {
      assert.ok(typeof ph.name === 'string' && ph.name.length > 0);
      for (const m of ph.moves) {
        assert.ok(['U', 'D', 'L', 'R', 'F', 'B'].includes(m[0]), `Solver should emit outer face moves, got ${m}`);
        applyMoveToState(verifyCube, m);
        totalMoves++;
      }
    }

    assert.equal(isStateSolved(verifyCube), true, `Trial ${trial} failed to reach solved state (scramble: ${scramble.join(' ')})`);
    if (!isStateSolved(cube)) {
      assert.ok(totalMoves > 0, 'Non-solved cube should require > 0 moves');
    }
  }
});

test('7-step LBL solver solves cubes after arbitrary manual + middle-slice (M, E, S) twists', () => {
  const allMoves = ['U', "U'", 'R', "R'", 'F', "F'", 'L', "L'", 'D', "D'", 'B', "B'", 'M', "M'", 'E', "E'", 'S', "S'"];
  for (let trial = 0; trial < 50; trial++) {
    const cube = createSolvedState();
    for (let i = 0; i < 25; i++) {
      const m = allMoves[(trial * 7 + i * 13) % allMoves.length];
      applyMoveToState(cube, m);
    }
    const phases = solveCubeLBL(cube);
    const verifyCube = cloneState(cube);
    for (const ph of phases) {
      for (const m of ph.moves) {
        applyMoveToState(verifyCube, m);
      }
    }
    assert.equal(isStateSolved(verifyCube), true, `Middle-slice trial ${trial} failed to solve`);
  }
});
