const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Chess } = require('chess.js');

const app = express();

const allowedOriginsRaw = process.env.ALLOWED_ORIGINS;
const allowedOrigins = allowedOriginsRaw
  ? allowedOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean)
  : '*';

app.use(
  cors(
    allowedOrigins === '*'
      ? undefined
      : {
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
              return;
            }
            callback(new Error('CORS not allowed'));
          },
          methods: ['GET', 'POST'],
        }
  )
);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// Store active games and rooms
const rooms = {};
const games = {};

// Define allowed piece types for dice
const DICE_PIECES = ['pawn', 'knight', 'bishop', 'rook', 'queen'];

// Dice names → chess.js piece letters
const DICE_TO_PIECE = {
  pawn: 'p',
  knight: 'n',
  bishop: 'b',
  rook: 'r',
  queen: 'q'
};

/**
 * Returns true if the current position has at least one legal move
 * using one of the rolled piece types. Server-side verification so the
 * client can't claim "no legal moves" falsely to fish for free re-rolls.
 */
function hasLegalDiceMove(fen, diceResults) {
  try {
    const chess = new Chess(fen);
    const allowedTypes = (diceResults || []).map((d) => DICE_TO_PIECE[d]);
    const legalMoves = chess.moves({ verbose: true }); // each move has .piece: 'p','n','b','r','q','k'
    return legalMoves.some((move) => allowedTypes.includes(move.piece));
  } catch (err) {
    // Never let a malformed FEN crash the socket handler
    console.error('hasLegalDiceMove error:', err.message);
    return true; // fail open: don't auto-approve on bad data
  }
}

// API endpoint to create a new room
app.post('/api/create-room', (req, res) => {
  const roomId = uuidv4().substring(0, 8); // Generate shorter room ID for ease of use
  // Store game mode in room data (default to standard if not specified)
  const gameMode = req.body.gameMode || 'standard';
  
  rooms[roomId] = { 
    players: [], 
    gameState: null,
    gameMode: gameMode,  // Store the game mode in room data
    diceResults: {},     // Store dice results for each player
    currentTurn: null,   // Track whose turn it is
    rerollRequest: null  // Track re-roll requests
  };
  
  res.json({ roomId, gameMode });
});

// API endpoint to check if a room exists
app.get('/api/check-room/:roomId', (req, res) => {
  const { roomId } = req.params;
  
  if (!rooms[roomId]) {
    return res.status(404).json({ exists: false, message: 'Room not found' });
  }
  
  if (rooms[roomId]?.players?.length >= 2) {
    return res.status(400).json({ exists: true, full: true, message: 'Room is full' });
  }
  
  res.json({ 
    exists: true, 
    full: false,
    gameMode: rooms[roomId].gameMode  // Return the game mode in the response
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join room event
  socket.on('join-room', ({ roomId, playerName }) => {
    console.log(`Player ${playerName} joining room ${roomId}`);
    
    // Check if player is already in the room
    const existingPlayerIndex = rooms[roomId]?.players?.findIndex(player => player?.id === socket?.id);
    
    const isAnExistingPlayer = existingPlayerIndex !== -1;
    
    // Check if the room exists
    if (!rooms[roomId] && !isAnExistingPlayer) {
      socket.emit('room-error', { message: 'Room does not exist' });
      return;
    }
    
    // Check if room is full
    if (rooms[roomId].players.length >= 2 && !isAnExistingPlayer) {
      socket.emit('room-error', { message: 'Room is full' });
      return;
    }
    
    
    if (isAnExistingPlayer) {
      console.log(`Player ${playerName} (${socket.id}) already in room ${roomId}`);
      // Player already in room, update their info if needed (e.g. name)
      rooms[roomId].players[existingPlayerIndex].name = playerName;
      
      // Re-emit the room-joined event with current data
      socket.emit('room-joined', { 
        roomId, 
        color: rooms[roomId].players[existingPlayerIndex].color, 
        players: rooms[roomId].players,
        gameMode: rooms[roomId].gameMode  // Include the game mode
      });
      return;
    }
    
    // Assign player color (white for first player, black for second)
    const playerColor = rooms[roomId].players.length === 0 ? 'white' : 'black';
    
    // Add player to the room
    const player = {
      id: socket.id,
      name: playerName,
      color: playerColor
    };
    
    rooms[roomId].players.push(player);
    
    // Join the socket room
    socket.join(roomId);
    
    // Notify the player they joined successfully
    socket.emit('room-joined', { 
      roomId, 
      color: playerColor, 
      players: rooms[roomId].players,
      gameMode: rooms[roomId].gameMode  // Include the game mode
    });
    
    // If this is the second player, initialize the game
    if (rooms[roomId].players.length === 2) {
      // Initialize the game with starting position in FEN notation
      const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      rooms[roomId].gameState = initialFen;
      rooms[roomId].currentTurn = 'white'; // White moves first
      
      // Notify all players in the room that the game is starting
      io.to(roomId).emit('game-start', {
        fen: initialFen,
        players: rooms[roomId].players,
        gameMode: rooms[roomId].gameMode  // Include the game mode
      });
    } else {
      // Notify the room that a player is waiting
      socket.to(roomId).emit('player-joined', { player });
    }
  });

  // Handle dice rolling for dice chess mode
  socket.on('roll-dice', ({ roomId }) => {
    // Check if room exists and game mode is dice-chess
    if (!rooms[roomId] || rooms[roomId].gameMode !== 'dice-chess') {
      socket.emit('dice-error', { message: 'Invalid room or game mode' });
      return;
    }
    
    // Find player in room
    const playerIndex = rooms[roomId].players.findIndex(player => player.id === socket.id);
    if (playerIndex === -1) {
      socket.emit('dice-error', { message: 'Player not found in room' });
      return;
    }
    
    const player = rooms[roomId].players[playerIndex];
    const playerColor = player.color;
    
    // Check if it's the player's turn
    if (rooms[roomId].currentTurn !== playerColor) {
      socket.emit('dice-error', { message: 'Not your turn to roll dice' });
      return;
    }
    
    // Clear any existing re-roll request
    rooms[roomId].rerollRequest = null;
    
    // Roll three dice - pick random pieces
    const diceResults = Array(3).fill(0).map(() => {
      const randomIndex = Math.floor(Math.random() * DICE_PIECES.length);
      return DICE_PIECES[randomIndex];
    });
    
    // Store dice results for the current player
    rooms[roomId].diceResults[playerColor] = diceResults;
    
    console.log(`Player ${playerColor} rolled: ${diceResults.join(', ')}`);
    
    // Emit dice result to the player
    socket.emit('dice-result', { diceResults });
    // Inform opponent about dice roll (now including the results)
    socket.to(roomId).emit('opponent-rolled-dice', { 
      color: playerColor,
      diceResults: diceResults
    });
  });

  // Forward dice results to opponent
  socket.on('opponent-dice-results', ({ roomId, diceResults }) => {
    // Check if room exists and game mode is dice-chess
    if (!rooms[roomId] || rooms[roomId].gameMode !== 'dice-chess') {
      return;
    }
    
    // Find player in room
    const playerIndex = rooms[roomId].players.findIndex(player => player.id === socket.id);
    if (playerIndex === -1) {
      return;
    }
    
    const player = rooms[roomId].players[playerIndex];
    const playerColor = player.color;
    
    // Forward dice results to opponent
    socket.to(roomId).emit('opponent-dice-results', { 
      diceResults 
    });
  });

  // Handle re-roll request
  socket.on('request-reroll', ({ roomId, reason }) => {
    // Check if room exists and game mode is dice-chess
    if (!rooms[roomId] || rooms[roomId].gameMode !== 'dice-chess') {
      socket.emit('dice-error', { message: 'Invalid room or game mode' });
      return;
    }
    
    // Find player in room
    const playerIndex = rooms[roomId].players.findIndex(player => player.id === socket.id);
    if (playerIndex === -1) {
      socket.emit('dice-error', { message: 'Player not found in room' });
      return;
    }
    
    const player = rooms[roomId].players[playerIndex];
    const playerColor = player.color;
    
    // Check if it's the player's turn
    if (rooms[roomId].currentTurn !== playerColor) {
      socket.emit('dice-error', { message: 'Not your turn to request a re-roll' });
      return;
    }
    
    // Check if dice have been rolled
    if (!rooms[roomId].diceResults[playerColor] || rooms[roomId].diceResults[playerColor].length === 0) {
      socket.emit('dice-error', { message: 'You need to roll the dice first before requesting a re-roll' });
      return;
    }

    // 🆕 GAME-OVER GUARD: a truly finished game (board checkmate/stalemate)
    // must never be re-rolled — that ends the game, not loops dice.
    const gameFen = rooms[roomId].gameState;
    if (gameFen) {
      try {
        const chess = new Chess(gameFen);
        if (chess.isCheckmate() || chess.isStalemate()) {
          socket.emit('dice-error', { message: 'The game is over — no re-roll available' });
          return;
        }
      } catch (err) {
        console.error('game-over check error:', err.message); // fail open, continue below
      }
    }

    // 🆕 AUTO-APPROVE: server-verified "no legal move with rolled pieces"
    const playerDice = rooms[roomId].diceResults[playerColor];
    if (gameFen && playerDice && !hasLegalDiceMove(gameFen, playerDice)) {
      console.log(`Auto-approving reroll for ${playerColor} in ${roomId}: no legal moves`);

      // Clear dice so they can roll again (same as a manual approval)
      rooms[roomId].diceResults[playerColor] = [];

      // Notify the requester (same shape the client already handles, + auto flag)
      socket.emit('reroll-response', {
        approved: true,
        auto: true,
        responderName: 'Auto (no legal moves)'
      });

      // Notify the opponent so their UI shows what happened
      socket.to(roomId).emit('reroll-auto-approved', {
        color: playerColor,
        playerName: player.name
      });

      return; // skip the negotiation flow entirely
    }

    // Store re-roll request
    rooms[roomId].rerollRequest = {
      playerId: socket.id,
      playerColor: playerColor,
      reason: reason
    };
    
    console.log(`Player ${playerColor} requested a re-roll. Reason: ${reason}`);
    
    // Notify the opponent about the re-roll request
    socket.to(roomId).emit('reroll-requested', { 
      color: playerColor,
      reason: reason,
      playerName: player.name
    });
    
    // Confirm to the requesting player that their request was sent
    socket.emit('reroll-request-sent');
  });
  
  // Handle re-roll response
  socket.on('respond-to-reroll', ({ roomId, approved }) => {
    // Check if room exists and has an active re-roll request
    if (!rooms[roomId] || !rooms[roomId].rerollRequest) {
      socket.emit('dice-error', { message: 'No active re-roll request' });
      return;
    }
    
    // Find player in room
    const playerIndex = rooms[roomId].players.findIndex(player => player.id === socket.id);
    if (playerIndex === -1) {
      socket.emit('dice-error', { message: 'Player not found in room' });
      return;
    }
    
    const player = rooms[roomId].players[playerIndex];
    const requester = rooms[roomId].players.find(p => p.id === rooms[roomId].rerollRequest.playerId);
    
    if (!requester) {
      socket.emit('dice-error', { message: 'Requesting player not found' });
      return;
    }
    
    if (approved) {
      // Notify the requester that their re-roll was approved
      io.to(requester.id).emit('reroll-response', { 
        approved: true,
        responderName: player.name
      });
      
      // Clear dice results to allow re-rolling
      rooms[roomId].diceResults[requester.color] = [];
    } else {
      // Notify the requester that their re-roll was denied
      io.to(requester.id).emit('reroll-response', { 
        approved: false,
        responderName: player.name
      });
    }
    
    // Clear the re-roll request
    rooms[roomId].rerollRequest = null;
  });

  // Handle chess moves
  socket.on('move', ({ roomId, move, newFen }) => {
    console.log(`Move in room ${roomId}:`, move);
    
    if (!rooms[roomId]) {
      socket.emit('move-error', { message: 'Room does not exist' });
      return;
    }
    
    // Get player color
    const playerIndex = rooms[roomId].players.findIndex(player => player.id === socket.id);
    if (playerIndex === -1) {
      socket.emit('move-error', { message: 'Player not found in room' });
      return;
    }
    const playerColor = rooms[roomId].players[playerIndex].color;
    
    // Check if it's dice chess mode
    if (rooms[roomId].gameMode === 'dice-chess') {
      // Check if dice have been rolled
      const diceResults = rooms[roomId].diceResults[playerColor];
      if (!diceResults || diceResults.length === 0) {
        socket.emit('move-error', { message: 'You must roll the dice before moving' });
        return;
      }
      
      // Get the piece type from the move
      // Move.piece is a property from chess.js move object that contains the piece type
      const movedPieceType = move.piece;
      
      // Convert chess.js piece notation to our dice pieces format
      // chess.js uses 'p' for pawn, 'n' for knight, etc.
      const pieceTypeMap = {
        'p': 'pawn',
        'n': 'knight',
        'b': 'bishop',
        'r': 'rook',
        'q': 'queen',
        'k': 'king'
      };
      
      const normalizedPieceType = pieceTypeMap[movedPieceType];
      
      // Check if the moved piece type is allowed by the dice roll
      if (!diceResults.includes(normalizedPieceType)) {
        socket.emit('move-error', { 
          message: `You can only move ${diceResults.join(', ')} based on your dice roll` 
        });
        return;
      }
      
      // Clear dice results after a valid move
      rooms[roomId].diceResults[playerColor] = [];
      
      // Clear any re-roll request
      rooms[roomId].rerollRequest = null;
    }
    
    // Update game state
    rooms[roomId].gameState = newFen;
    
    // Update current turn
    rooms[roomId].currentTurn = playerColor === 'white' ? 'black' : 'white';
    
    // Broadcast the move to the other player
    socket.to(roomId).emit('opponent-move', { move, newFen });
  });

  // Handle game end events
  socket.on('game-over', ({ roomId, result }) => {
    if (rooms[roomId]) {
      io.to(roomId).emit('game-ended', { result });
    }
  });

  // Handle player disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Find all rooms the player was in
    for (const roomId in rooms) {
      const playerIndex = rooms[roomId].players.findIndex(player => player.id === socket.id);
      
      if (playerIndex !== -1) {
        // Remove the player
        rooms[roomId].players.splice(playerIndex, 1);
        
        // Notify others in the room
        io.to(roomId).emit('player-left', { 
          playerId: socket.id,
          remaining: rooms[roomId].players
        });
        
        // If room is empty, clean it up
        if (rooms[roomId].players.length === 0) {
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
