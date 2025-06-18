const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config();
const socketIO = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose'); // Import Mongoose

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "https://incandescent-haupia-4eca78.netlify.app/, 'http://localhost:4000",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';


// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB Connected...'))
.catch(err => console.error(err));

// User Schema and Model
const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    }
});

const User = mongoose.model('User', UserSchema);

// Middleware for parsing JSON bodies
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// Global map to store rooms and their users
const chatRooms = {
    'general': new Set(), // Default room
};
// Map to track which room each socket is currently in
const socketRoomMap = new Map();

// Helper functions for user data (replaced by Mongoose)
// async function readUsers() { /* ... */ }
// async function writeUsers(users) { /* ... */ }

// Socket.IO authentication middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        console.log('Socket connection rejected: No token provided');
        return next(new Error('Authentication error: No token'));
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            console.log('Socket connection rejected: Invalid token', err.message);
            return next(new Error('Authentication error: Invalid token'));
        }
        socket.username = decoded.username; // Attach username to socket
        console.log(`Socket connected: ${socket.id} for user: ${socket.username}`);
        next();
    });
});

// Authentication Routes (updated to use Mongoose)
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }

    try {
        let user = await User.findOne({ username });
        if (user) {
            return res.status(409).json({ message: 'Username already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10); // Hash with 10 salt rounds
        user = new User({ username, password: hashedPassword });
        await user.save();

        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }

    try {
        const user = await User.findOne({ username });

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ message: 'Login successful', token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login' });
    }
});

let socketsConnected = new Set();
io.on('connection', onConnected);
function onConnected(socket) {
    console.log(`Socket connected: ${socket.id} for user: ${socket.username}`);
    socketsConnected.add(socket.id);

    // Initial room assignment: try to join 'general' room or create a personal room
    joinRoom(socket, 'general');

    // Send total clients (consider if this should be total in app or total in current room)
    io.emit('client-total', socketsConnected.size);

    socket.on('disconnect', () => {
        console.log('Socket disconnected', socket.id);
        socketsConnected.delete(socket.id);
        io.emit('client-total', socketsConnected.size);

        // Remove from current room
        const currentRoom = socketRoomMap.get(socket.id);
        if (currentRoom && chatRooms[currentRoom]) {
            chatRooms[currentRoom].delete(socket.id);
            if (chatRooms[currentRoom].size === 0 && currentRoom !== 'general') {
                delete chatRooms[currentRoom];
                sendAvailableRooms(); // Update room list if a room becomes empty
            } else {
                // Ensure room exists and filter out undefined sockets
                const usersInRoom = Array.from(chatRooms[currentRoom])
                    .map(sId => io.sockets.sockets.get(sId))
                    .filter(s => s !== undefined) // Filter out disconnected sockets
                    .map(s => s.username);
                io.to(currentRoom).emit('room-users', usersInRoom);
            }
        }
        socketRoomMap.delete(socket.id);
    });

    // Modified message event to be room-specific
    socket.on('message', (data) => {
        const currentRoom = socketRoomMap.get(socket.id);
        if (currentRoom) {
            data.name = socket.username;
            console.log(`Message in room ${currentRoom} from ${data.name}: ${data.message}`);
            io.to(currentRoom).emit('chat-message', data);
        } else {
            console.warn(`Socket ${socket.id} tried to send message without being in a room.`);
        }
    });

    // Modified feedback event to be room-specific
    socket.on('feedback', (data) => {
        const currentRoom = socketRoomMap.get(socket.id);
        if (currentRoom) {
            data.name = socket.username; // Ensure feedback also has username
            // Only broadcast to others in the same room
            socket.to(currentRoom).emit('feedback', data);
        }
    });

    // New event to get available rooms
    socket.on('get-rooms', sendAvailableRooms);

    // New event to create/join a room
    socket.on('join-room', (roomName) => {
        joinRoom(socket, roomName);
    });

    // New event to delete a room
    socket.on('delete-room', (roomName) => {
        // Prevent deletion of the general room
        if (roomName === 'general') {
            return;
        }

        // Check if room exists
        if (chatRooms[roomName]) {
            // Move all users in the room to general
            const usersInRoom = Array.from(chatRooms[roomName]);
            usersInRoom.forEach(userSocketId => {
                const userSocket = io.sockets.sockets.get(userSocketId);
                if (userSocket) {
                    joinRoom(userSocket, 'general');
                }
            });

            // Delete the room
            delete chatRooms[roomName];
            
            // Notify all clients about the room deletion
            io.emit('room-deleted', roomName);
            sendAvailableRooms();
        }
    });

    // Helper function to send available rooms list
    function sendAvailableRooms() {
        io.emit('available-rooms', Object.keys(chatRooms));
    }

    // Helper function to handle joining a room
    function joinRoom(socketToJoin, roomName) {
        // Leave current room if already in one
        const previousRoom = socketRoomMap.get(socketToJoin.id);
        if (previousRoom) {
            socketToJoin.leave(previousRoom);
            if (chatRooms[previousRoom]) { // Ensure the room still exists
                chatRooms[previousRoom].delete(socketToJoin.id);
                if (chatRooms[previousRoom].size === 0 && previousRoom !== 'general') {
                    delete chatRooms[previousRoom];
                    sendAvailableRooms(); // Update room list if a room becomes empty
                } else {
                    // Only emit room-users if the room still exists and has members
                    const usersInPreviousRoom = Array.from(chatRooms[previousRoom])
                        .map(sId => io.sockets.sockets.get(sId))
                        .filter(s => s !== undefined) // Filter out disconnected sockets
                        .map(s => s.username);
                    io.to(previousRoom).emit('room-users', usersInPreviousRoom);
                }
            }
        }

        // Create room if it doesn't exist
        if (!chatRooms[roomName]) {
            chatRooms[roomName] = new Set();
            sendAvailableRooms(); // Notify all clients about the new room
        }

        socketToJoin.join(roomName);
        chatRooms[roomName].add(socketToJoin.id);
        socketRoomMap.set(socketToJoin.id, roomName);

        // Emit 'joined-room' event to the joining client with the room name
        socketToJoin.emit('joined-room', roomName);
        // Emit 'room-users' to all clients in the new room (as it definitely exists and has members)
        const usersInNewRoom = Array.from(chatRooms[roomName])
            .map(sId => io.sockets.sockets.get(sId))
            .filter(s => s !== undefined) // Filter out disconnected sockets
            .map(s => s.username);
        io.to(roomName).emit('room-users', usersInNewRoom);
        console.log(`${socketToJoin.username} joined room: ${roomName}`);

        // Clear messages for the joining user when they switch rooms
        socketToJoin.emit('clear-messages');
    }
}

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
