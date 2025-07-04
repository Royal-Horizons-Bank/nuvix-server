// server.js - FINAL CORRECTED VERSION

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// This serves your HTML, CSS, and JS files
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const parties = {}; 

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('joinParty', ({ partyId, userProfile }) => {
    socket.join(partyId);
    socket.partyId = partyId;

    const participant = { ...userProfile, id: socket.id };
    socket.userProfile = participant;
    
    if (!parties[partyId]) {
      parties[partyId] = { 
        participants: {},
        hostId: socket.id,
        state: 'paused'
      };
    }
    
    participant.isHost = (socket.id === parties[partyId].hostId);
    parties[partyId].participants[socket.id] = participant;

    console.log(`${participant.name} (${participant.id}) joined party ${partyId}. Host: ${participant.isHost}`);

    socket.emit('newPartyState', { 
        newState: parties[partyId].state, 
        byHostName: parties[partyId].participants[parties[partyId].hostId].name 
    });

    socket.to(partyId).emit('systemMessage', `${participant.name} has joined the party.`);
    io.in(partyId).emit('updateParticipants', Object.values(parties[partyId].participants));
  });

  socket.on('partyStateChange', ({ newState }) => {
    const { partyId, userProfile } = socket;
    if (!partyId || !parties[partyId] || socket.id !== parties[partyId].hostId) return;
    
    parties[partyId].state = newState;
    io.in(partyId).emit('newPartyState', { newState, byHostName: userProfile.name });
  });

  // --- THIS IS THE CORRECTED CHAT HANDLER ---
  // It correctly expects a data object with 'type' and 'content' properties.
  socket.on('chatMessage', (data) => {
    if (!socket.partyId || !socket.userProfile || !data || !data.type || !data.content) return;
    
    const chatData = {
      user: socket.userProfile,
      type: data.type,
      content: data.content,
      timestamp: new Date()
    };
    io.in(socket.partyId).emit('newChatMessage', chatData);
  });
  // ------------------------------------------


   // --- ADD THESE NEW HANDLERS FOR TYPING INDICATOR ---

  // When a user starts typing
  socket.on('typingStart', () => {
    // Broadcast to others in the room that this user is typing
    if (socket.partyId && socket.userProfile) {
      socket.to(socket.partyId).emit('userIsTyping', socket.userProfile);
    }
  });

  // When a user stops typing
  socket.on('typingStop', () => {
    // Broadcast to others that this user has stopped typing
    if (socket.partyId && socket.userProfile) {
      socket.to(socket.partyId).emit('userStoppedTyping', socket.userProfile);
    }
  });


  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const { partyId, userProfile } = socket;
    
    if (partyId && parties[partyId] && parties[partyId].participants[socket.id]) {
      const wasHost = socket.id === parties[partyId].hostId;
      const participantName = userProfile ? userProfile.name : 'A user';
      
      delete parties[partyId].participants[socket.id];
      
      if (Object.keys(parties[partyId].participants).length === 0) {
        delete parties[partyId];
        console.log(`Party ${partyId} is now empty and has been closed.`);
      } else {
        if (wasHost) {
          const newHostId = Object.keys(parties[partyId].participants)[0];
          parties[partyId].hostId = newHostId;
          parties[partyId].participants[newHostId].isHost = true;
          io.in(partyId).emit('systemMessage', `${participantName} (the host) has left. ${parties[partyId].participants[newHostId].name} is the new host.`);
        } else {
          io.in(partyId).emit('systemMessage', `${participantName} has left the party.`);
        }
        io.in(partyId).emit('updateParticipants', Object.values(parties[partyId].participants));
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ Nuvix+ server is running on http://localhost:${PORT}`);
});