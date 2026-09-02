// Isolated test for hasLegalDiceMove — run: node test-dice.js
// (Temporary scratch file; safe to delete after verifying.)
const { Chess } = require('chess.js');

const DICE_TO_PIECE = {
  pawn: 'p',
  knight: 'n',
  bishop: 'b',
  rook: 'r',
  queen: 'q'
};

function hasLegalDiceMove(fen, diceResults) {
  try {
    const chess = new Chess(fen);
    const allowedTypes = (diceResults || []).map((d) => DICE_TO_PIECE[d]);
    const legalMoves = chess.moves({ verbose: true });
    return legalMoves.some((move) => allowedTypes.includes(move.piece));
  } catch (err) {
    console.error('hasLegalDiceMove error:', err.message);
    return true;
  }
}

// Position: White = King a1 + Rook h1. Black = King a8. White to move.
const fen = 'k7/8/8/8/8/8/8/K6R w - - 0 1';

console.log('roll includes rook   →', hasLegalDiceMove(fen, ['rook']), '(expect true)');
console.log('roll pawn/queen only →', hasLegalDiceMove(fen, ['pawn', 'queen']), '(expect false)');
console.log('empty roll           →', hasLegalDiceMove(fen, []), '(expect false)');
console.log('bad FEN (fails open) →', hasLegalDiceMove('garbage-fen', ['rook']), '(expect true)');
