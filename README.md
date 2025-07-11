# Chat Application Server

This is the backend server for a real-time chat application built with Node.js, Express, Socket.IO, and MongoDB (via Mongoose). It supports user authentication, room-based messaging, and message persistence for 24 hours.

## Features

- User registration and login with JWT authentication
- Real-time messaging using Socket.IO
- Room-based chat (create, join, leave, and delete rooms)
- Message history for the last 24 hours (per room)
- CORS support for frontend integration
- MongoDB for user and message storage

## Prerequisites

- Node.js (v14 or higher recommended)
- MongoDB instance (local or cloud, e.g., MongoDB Atlas)

## Setup

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Variables:**
   Create a `.env` file (or set environment variables in your deployment) with:
   ```env
   MONGODB_URI=<your-mongodb-connection-string>
   JWT_SECRET=<your-secret-key>
   PORT=4000 # Optional, defaults to 4000
   ```

4. **Start the server:**
   ```bash
   node app.js
   ```
   The server will run on `http://localhost:4000` by default.

## API Endpoints

### Authentication

- **POST /register**
  - Register a new user.
  - Body: `{ "username": "string", "password": "string" }`
  - Response: `{ message: "User registered successfully" }`

- **POST /login**
  - Login and receive a JWT token.
  - Body: `{ "username": "string", "password": "string" }`
  - Response: `{ message: "Login successful", token: "<jwt>" }`

### WebSocket (Socket.IO)

- **Authentication:**
  - Connect with Socket.IO using the JWT token:
    ```js
    const socket = io('http://localhost:4000', {
      auth: { token: '<jwt>' }
    });
    ```

- **Events:**
  - `message`: Send a chat message to the current room.
  - `feedback`: Send typing/feedback events to the current room.
  - `get-rooms`: Request the list of available rooms.
  - `join-room`: Join or create a room.
  - `delete-room`: Delete a room (except 'general').
  - `leave-room`: Leave a room.
  - `disconnecting`: Handle user disconnect from all rooms.
  - `room-history`: Receive last 24 hours of messages for a room.
  - `room-users`: Receive the list of users in a room.
  - `available-rooms`: Receive the list of all rooms.
  - `joined-room`: Confirmation of joining a room.
  - `clear-messages`: Signal to clear chat history on the client.
  - `room-deleted`: Notification that a room was deleted.
  - `client-total`: Total number of connected clients.

## Project Structure

- `app.js` - Main server file
- `package.json` - Project dependencies and scripts
- `users.json` - (Legacy, not used with MongoDB)

## Notes

- The default chat room is `general` and cannot be deleted.
- Messages are stored in MongoDB and expire after 24 hours.
- CORS is enabled for the specified frontend origins.

## Disclaimer

For educational purposes only. 