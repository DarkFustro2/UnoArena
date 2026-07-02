const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {};

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
    let deck = [];

    for (let color of colors) {
        for (let value of values) {
            deck.push({ color, value });
            if (value !== '0') deck.push({ color, value });
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'Wild' });
        deck.push({ color: 'black', value: '+4' });
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    
    // 1. Oda Oluşturma
    socket.on('createRoom', (data) => {
        let roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        let playerName = data && data.name ? data.name.trim() : "Oyuncu 1";
        
        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: playerName + " (Host)", cards: [] }],
            started: false,
            deck: [],
            discardPile: [],
            currentTurn: 0,
            direction: 1,
            pendingColorChange: false
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    // 2. Odaya Katılma
    socket.on('joinRoom', (data) => {
        let roomCode = data.roomCode ? data.roomCode.trim().toUpperCase() : "";
        let playerName = data.name ? data.name.trim() : "Oyuncu";

        if (!roomCode || !rooms[roomCode]) {
            return socket.emit('errorMsg', 'Oda bulunamadı veya kod yanlış!');
        }
        if (rooms[roomCode].players.length >= 4) {
            return socket.emit('errorMsg', 'Oda dolu! (Maksimum 4 kişi)');
        }
        if (rooms[roomCode].started) {
            return socket.emit('errorMsg', 'Bu oda için oyun zaten başladı!');
        }
        
        rooms[roomCode].players.push({ id: socket.id, name: playerName, cards: [] });
        socket.join(roomCode);
        
        io.to(roomCode).emit('playerJoined', { players: rooms[roomCode].players });
    });

    // 3. Oyunu Başlatma
    socket.on('startGame', (roomCode) => {
        let room = rooms[roomCode];
        if (room && room.host === socket.id) {
            if(room.players.length < 2) {
                return socket.emit('errorMsg', 'Oyunu başlatmak için en az 2 oyuncu gerekiyor!');
            }
            room.started = true;
            room.deck = createDeck();
            
            room.players.forEach(player => {
                player.cards = [];
                for(let i=0; i<7; i++) {
                    player.cards.push(room.deck.pop());
                }
            });

            let firstCard = room.deck.pop();
            while(firstCard.color === 'black') {
                room.deck.unshift(firstCard);
                firstCard = room.deck.pop();
            }
            room.discardPile.push(firstCard);
            room.currentTurn = 0; 

            sendStateToAll(roomCode);
        }
    });

    // 4. Kart Atma
    socket.on('playCard', (data) => {
        let room = rooms[data.roomCode];
        if (!room || !room.started || room.pendingColorChange) return;

        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return; 

        let topCard = room.discardPile[room.discardPile.length - 1];
        let playedCard = data.card;

        if (playedCard.color === topCard.color || playedCard.value === topCard.value || playedCard.color === 'black') {
            
            let cardIndex = activePlayer.cards.findIndex(c => c.color === playedCard.color && c.value === playedCard.value);
            if (cardIndex > -1) {
                activePlayer.cards.splice(cardIndex, 1);
            } else {
                return;
            }

            room.discardPile.push(playedCard);

            if (activePlayer.cards.length === 0) {
                io.to(data.roomCode).emit('gameOver', { winner: activePlayer.name });
                delete rooms[data.roomCode];
                return;
            }

            if (playedCard.color === 'black') {
                room.pendingColorChange = true;
                socket.emit('chooseColor', { value: playedCard.value });
                return; 
            }

            processCardAction(room, playedCard);
            sendStateToAll(data.roomCode);
        }
    });

    // Renk Seçimi Sonrası
    socket.on('colorSelected', (data) => {
        let room = rooms[data.roomCode];
        if (!room || !room.pendingColorChange) return;

        let topCard = room.discardPile[room.discardPile.length - 1];
        topCard.color = data.color; 
        room.pendingColorChange = false;

        if (topCard.value === '+4') {
            let nextTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
            let victim = room.players[nextTurn];
            for(let i=0; i<4; i++) if(room.deck.length > 0) victim.cards.push(room.deck.pop());
            room.currentTurn = (nextTurn + room.direction + room.players.length) % room.players.length;
        } else {
            room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        }

        sendStateToAll(data.roomCode);
    });

    // Kart Çekme
    socket.on('drawCard', (roomCode) => {
        let room = rooms[roomCode];
        if (!room || !room.started || room.pendingColorChange) return;

        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return;

        if (room.deck.length === 0) {
            let topCard = room.discardPile.pop();
            room.deck = room.discardPile.sort(() => Math.random() - 0.5);
            room.discardPile = [topCard];
        }

        if (room.deck.length > 0) {
            activePlayer.cards.push(room.deck.pop());
        }

        room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        sendStateToAll(roomCode);
    });

    // Odadan Çıkma
    socket.on('leaveRoom', (roomCode) => {
        if(rooms[roomCode]) {
            rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== socket.id);
            io.to(roomCode).emit('playerJoined', { players: rooms[roomCode].players });
            if(rooms[roomCode].players.length === 0 || rooms[roomCode].host === socket.id) {
                delete rooms[roomCode];
            }
        }
        socket.leave(roomCode);
        socket.emit('leftRoom');
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            let room = rooms[code];
            let pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex > -1) {
                room.players.splice(pIndex, 1);
                io.to(code).emit('playerJoined', { players: room.players });
                if (room.players.length === 0 || room.host === socket.id) {
                    delete rooms[code];
                }
                break;
            }
        }
    });
});

function processCardAction(room, playedCard) {
    if (playedCard.value === 'Reverse') {
        room.direction *= -1;
    }
    let nextTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;

    if (playedCard.value === 'Skip') {
        nextTurn = (nextTurn + room.direction + room.players.length) % room.players.length;
    } else if (playedCard.value === '+2') {
        let victim = room.players[nextTurn];
        for(let i=0; i<2; i++) if(room.deck.length > 0) victim.cards.push(room.deck.pop());
        nextTurn = (nextTurn + room.direction + room.players.length) % room.players.length;
    }
    room.currentTurn = nextTurn;
}

function sendStateToAll(roomCode) {
    let room = rooms[roomCode];
    if (!room) return;

    room.players.forEach((player, index) => {
        let opponents = room.players
            .filter(p => p.id !== player.id)
            .map(p => ({ name: p.name, cardCount: p.cards.length }));

        io.to(player.id).emit('gameStateUpdate', {
            myCards: player.cards,
            opponents: opponents,
            discardPile: room.discardPile,
            isMyTurn: room.currentTurn === index && !room.pendingColorChange,
            currentTurnName: room.players[room.currentTurn].name,
            pendingColorChange: room.pendingColorChange
        });
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Sunucu aktif.`));
