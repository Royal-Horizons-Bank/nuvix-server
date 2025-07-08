// server.js - UPGRADED VERSION

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();

// --- DATABASE SETUP ---
// Connect to the SQLite database. It will be created if it doesn't exist.
const db = new sqlite3.Database('./nuvix.db', (err) => {
    if (err) {
        return console.error("Error opening database: " + err.message);
    }
    console.log("Database connected successfully!");
    // Use serialize to ensure table creation happens in order.
    db.serialize(() => {
        // Create a table for user profiles to make them searchable
        db.run(`CREATE TABLE IF NOT EXISTS profiles (
            user_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar_image TEXT,
            avatar_color TEXT
        )`);

        // Create a table for friendships and friend requests
        db.run(`CREATE TABLE IF NOT EXISTS friendships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_key_1 TEXT NOT NULL,
            user_key_2 TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'accepted')),
            action_user_key TEXT NOT NULL,
            UNIQUE(user_key_1, user_key_2)
        )`);

        // Create a table for storing direct messages
        db.run(`CREATE TABLE IF NOT EXISTS direct_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_key TEXT NOT NULL,
            receiver_key TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });
});

// --- EXPRESS APP & SOCKET.IO SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for simplicity
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Serve static files (HTML, CSS, JS) from the root directory
app.use(express.static(path.join(__dirname)));
app.use(express.json()); // Middleware to parse JSON bodies

const PORT = process.env.PORT || 3000;

// --- API ENDPOINTS ---

// Syncs profile data from frontend's localStorage to the backend DB
app.post('/api/profiles/sync', (req, res) => {
    const { key, name, avatarImage, avatarColor } = req.body;
    const query = `INSERT INTO profiles (user_key, name, avatar_image, avatar_color)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(user_key) DO UPDATE SET
                   name = excluded.name,
                   avatar_image = excluded.avatar_image,
                   avatar_color = excluded.avatar_color`;
    db.run(query, [key, name, avatarImage, avatarColor], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Profile synced' });
    });
});

// Search for users to add as friends
app.get('/api/users/search', (req, res) => {
    const { name, excludeUserKey } = req.query;
    const query = `SELECT user_key, name, avatar_image, avatar_color FROM profiles
                   WHERE name LIKE ? AND user_key != ? LIMIT 10`;
    db.all(query, [`%${name}%`, excludeUserKey], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Send a friend request
app.post('/api/friends/request', (req, res) => {
    const { requesterKey, recipientKey } = req.body;
    const [u1, u2] = [requesterKey, recipientKey].sort(); // Store keys in a consistent order
    const query = "INSERT INTO friendships (user_key_1, user_key_2, status, action_user_key) VALUES (?, ?, 'pending', ?)";
    db.run(query, [u1, u2, requesterKey], function(err) {
        if (err) return res.status(400).json({ error: "Request already sent or users are already friends." });
        res.status(201).json({ message: 'Friend request sent.' });
    });
});

// Accept a friend request
app.put('/api/friends/accept', (req, res) => {
    const { requesterKey, recipientKey } = req.body;
    const [u1, u2] = [requesterKey, recipientKey].sort();
    const query = "UPDATE friendships SET status = 'accepted' WHERE user_key_1 = ? AND user_key_2 = ? AND status = 'pending'";
    db.run(query, [u1, u2], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ message: "No pending request found." });
        res.json({ message: 'Friend request accepted.' });
    });
});

// Remove a friend or decline a request
app.delete('/api/friends/remove', (req, res) => {
    const { userKey1, userKey2 } = req.body;
    const [u1, u2] = [userKey1, userKey2].sort();
    const query = "DELETE FROM friendships WHERE user_key_1 = ? AND user_key_2 = ?";
    db.run(query, [u1, u2], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Friendship removed or request declined.' });
    });
});

// Get a user's full friends list (pending and accepted)
app.get('/api/friends/:userKey', (req, res) => {
    const { userKey } = req.params;
    const query = "SELECT * FROM friendships WHERE (user_key_1 = ? OR user_key_2 = ?)";
    db.all(query, [userKey, userKey], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Get chat history between two users
app.get('/api/messages/:userKey1/:userKey2', (req, res) => {
    const { userKey1, userKey2 } = req.params;
    const query = `SELECT * FROM direct_messages
                   WHERE (sender_key = ? AND receiver_key = ?) OR (sender_key = ? AND receiver_key = ?)
                   ORDER BY timestamp ASC LIMIT 100`;
    db.all(query, [userKey1, userKey2, userKey2, userKey1], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});


// --- SOCKET.IO REAL-TIME LOGIC ---
const onlineUsers = new Map(); // Maps userKey to socket.id

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // NEW: Register user and map their key to their socket ID
  socket.on('register', (userKey) => {
      onlineUsers.set(userKey, socket.id);
      socket.userKey = userKey; // Attach userKey to the socket object
      console.log(`User ${userKey} registered with socket ${socket.id}`);
  });

  // NEW: Handle incoming direct messages
  socket.on('direct_message', (data) => {
      const { sender_key, receiver_key, message } = data;
      const insertQuery = "INSERT INTO direct_messages (sender_key, receiver_key, message) VALUES (?, ?, ?)";
      
      db.run(insertQuery, [sender_key, receiver_key, message], function(err) {
          if (err) return console.error("Database error on message insert:", err.message);
          
          const fullMessage = { ...data, id: this.lastID, timestamp: new Date().toISOString() };

          // Send message to recipient if they are online
          const recipientSocketId = onlineUsers.get(receiver_key);
          if (recipientSocketId) {
              io.to(recipientSocketId).emit('new_direct_message', fullMessage);
          }
          // Send message back to the sender for their own UI
          socket.emit('new_direct_message', fullMessage);
      });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // Remove user from online users map
    if (socket.userKey) {
        onlineUsers.delete(socket.userKey);
    }
    // Note: The watch party disconnect logic can remain if you want to keep that feature.
  });
});

// Start the server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ Nuvix+ server is running on http://localhost:${PORT}`);
});