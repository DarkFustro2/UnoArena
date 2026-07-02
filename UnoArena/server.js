const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {};

// Gerçek bir UNO destesi oluşturma fonksiyonu
function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
    let deck = [];

    for (let color of colors) {
        for (let value of values) {
            deck.push({ color, value });
            if (value !== '0') deck.push({ color, value }); // 0 hariç her karttan 2şer tane olur
        }
    }
    // Joker Kartları
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'Wild' });
        deck.push({ color: 'black', value: '+4' });
    }
    return deck.sort(() => Math.random() - 0.5); // Karıştır
}

io.on('connection', (socket) => {
    // 1. Oda Oluşturma
    socket.on('createRoom', () => {
        let roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: "Oyuncu 1", cards: [] }],
            started: false,
            deck: [],
            discardPile: [],
            currentTurn: 0,
            direction: 1
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
    });

    // 2. Odaya Katılma
    socket.on('joinRoom', (roomCode) => {
        roomCode = roomCode.toUpperCase();
        if (rooms[roomCode]) {
            if (rooms[roomCode].players.length >= 4) {
                return socket.emit('errorMsg', 'Oda dolu! (Maks 4 kişi)');
            }
            if (rooms[roomCode].started) {
                return socket.emit('errorMsg', 'Oyun zaten başladı!');
            }
            
            let pNumber = rooms[roomCode].players.length + 1;
            rooms[roomCode].players.push({ id: socket.id, name: "Oyuncu " + pNumber, cards: [] });
            socket.join(roomCode);
            
            io.to(roomCode).emit('playerJoined', { players: rooms[roomCode].players });
        } else {
            socket.emit('errorMsg', 'Oda bulunamadı!');
        }
    });

    // 3. Oyunu Başlatma (Kartları Dağıtır)
    socket.on('startGame', (roomCode) => {
        let room = rooms[roomCode];
        if (room && room.host === socket.id) {
            room.started = true;
            room.deck = createDeck();
            
            // Her oyuncuya 7 kart dağıtıyoruz
            room.players.forEach(player => {
                player.cards = [];
                for(let i=0; i<7; i++) {
                    player.cards.push(room.deck.pop());
                }
            });

            // Ortaya ilk kartı aç (Siyah/Aksiyon kartı gelmeyene kadar açıyoruz)
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

    // 4. Kart Atma Mekaniği (Kurallı)
    socket.on('playCard', (data) => {
        let room = rooms[data.roomCode];
        if (!room || !room.started) return;

        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return; // Sıra sende değilse engelle

        let topCard = room.discardPile[room.discardPile.length - 1];
        let playedCard = data.card;

        // UNO KURAL KONTROLÜ: Renk tutmalı, sayı tutmalı veya siyah joker olmalı
        if (playedCard.color === topCard.color || playedCard.value === topCard.value || playedCard.color === 'black') {
            
            // Oyuncunun elinden kartı sil
            let cardIndex = activePlayer.cards.findIndex(c => c.color === playedCard.color && c.value === playedCard.value);
            if (cardIndex > -1) {
                activePlayer.cards.splice(cardIndex, 1);
            } else {
                return; // Elinde olmayan kartı atamaz
            }

            // Ortaya kartı koy
            room.discardPile.push(playedCard);

            // Oyunu bitirme kontrolü (Eğer elinde kart kalmadıysa)
            if (activePlayer.cards.length === 0) {
                io.to(data.roomCode).emit('gameOver', { winner: activePlayer.name });
                delete rooms[data.roomCode];
                return;
            }

            // Özel Aksiyon Kartlarının Yönetimi
            if (playedCard.value === 'Reverse') {
                room.direction *= -1;
            }
            
            // Sırayı geçir
            let nextTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;

            if (playedCard.value === 'Skip') {
                nextTurn = (nextTurn + room.direction + room.players.length) % room.players.length;
            } else if (playedCard.value === '+2') {
                let victim = room.players[nextTurn];
                for(let i=0; i<2; i++) if(room.deck.length > 0) victim.cards.push(room.deck.pop());
                nextTurn = (nextTurn + room.direction + room.players.length) % room.players.length;
            } else if (playedCard.value === '+4') {
                let victim = room.players[nextTurn];
                for(let i=0; i<4; i++) if(room.deck.length > 0) victim.cards.push(room.deck.pop());
                nextTurn = (nextTurn + room.direction + room.players.length) % room.players.length;
            }

            room.currentTurn = nextTurn;
            sendStateToAll(data.roomCode);
        }
    });

    // 5. Yerden Kart Çekme Mekaniği
    socket.on('drawCard', (roomCode) => {
        let room = rooms[roomCode];
        if (!room || !room.started) return;

        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return;

        if (room.deck.length === 0) {
            // Deste bittiyse ortadaki eski kartları karıştırıp yeni deste yap
            let topCard = room.discardPile.pop();
            room.deck = room.discardPile.sort(() => Math.random() - 0.5);
            room.discardPile = [topCard];
        }

        if (room.deck.length > 0) {
            activePlayer.cards.push(room.deck.pop());
        }

        // Kart çekince sırayı diğerine devret
        room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        sendStateToAll(roomCode);
    });

    // Herkese özel veri paketleme (Herkes sadece kendi kartını görmeli)
    function sendStateToAll(roomCode) {
        let room = rooms[roomCode];
        if (!room) return;

        room.players.forEach((player, index) => {
            // Rakipler listesini oluştur (id'leri gizleyerek kart sayılarını gönderir)
            let opponents = room.players
                .filter(p => p.id !== player.id)
                .map(p => ({ name: p.name, cardCount: p.cards.length }));

            io.to(player.id).emit('gameStateUpdate', {
                myCards: player.cards,
                opponents: opponents,
                discardPile: room.discardPile,
                isMyTurn: room.currentTurn === index,
                currentTurnName: room.players[room.currentTurn].name
            });
        });
    }

    socket.on('disconnect', () => {
        // Ayrılan oyuncu temizliği basitleştirilmiş
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Sunucu ${PORT} portunda canlıda!`));