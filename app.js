const express = require('express');
const http = require('http');
const path = require('path');
const socketIO = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose'); // Import Mongoose
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: ['https://charming-lamington-c1b952.netlify.app', 'http://localhost:4000'],
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

// Message Schema and Model
const MessageSchema = new mongoose.Schema({
    room: { type: String, required: true },
    sender: { type: String, required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, index: { expires: 60 * 60 * 24 } } // 24 hours TTL
});
const Message = mongoose.model('Message', MessageSchema);

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.use(cors({
    origin: ['https://charming-lamington-c1b952.netlify.app', 'http://localhost:4000']
}));

const chatRooms = {
    'general': new Set(), // Default room
};
const socketRoomMap = new Map();

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
                // Notify room that user has left
                io.to(currentRoom).emit('user-left', socket.username);
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

            // Save message to MongoDB
            const message = new Message({
                room: currentRoom,
                sender: socket.username,
                content: data.message,
                timestamp: new Date()
            });
            message.save().catch(err => console.error('Error saving message:', err));
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

        // Fetch last 24 hours of messages for the room
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        Message.find({ room: roomName, timestamp: { $gte: since } })
            .sort({ timestamp: 1 })
            .then(messages => {
                // Send messages to the joining client
                socketToJoin.emit('room-history', messages);
            })
            .catch(err => console.error('Error fetching room history:', err));

        // Emit 'room-users' to all clients in the new room (as it definitely exists and has members)
        const usersInNewRoom = Array.from(chatRooms[roomName])
            .map(sId => io.sockets.sockets.get(sId))
            .filter(s => s !== undefined) // Filter out disconnected sockets
            .map(s => s.username);
        io.to(roomName).emit('room-users', usersInNewRoom);
        console.log(`${socketToJoin.username} joined room: ${roomName}`);

        socketToJoin.emit('clear-messages');
    }
}
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
