require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;

const User = require('./models/User');
const Post = require('./models/Post');
const Counter = require('./models/Counter');
const Follow = require('./models/Follow');
const Chat = require('./models/Chat');
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary Secure Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true 
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error(err));

const JWT_SECRET = process.env.JWT_SECRET;

// Auth Middleware
const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    next();
  } catch { res.status(401).json({ error: 'Invalid Session' }); }
};

// Messaging Engine
io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(userId));
  socket.on('private message', async (data) => {
    const { to, content } = data;
    const msg = new Message({ sender: socket.userId, content }); // Simplified for brevity
    io.to(to).emit('private message', data);
  });
});

// Post Route with Cloudinary Fix
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { content, media } = req.body;
    let processedMedia = [];
    if (media?.length) {
      for (let item of media) {
        const upload = await cloudinary.uploader.upload(item.url, { folder: 'swarg_posts' });
        processedMedia.push({ url: upload.secure_url, type: 'image' });
      }
    }
    const post = new Post({ user: req.user._id, content, media: processedMedia });
    await post.save();
    res.status(201).json(post);
  } catch (err) { res.status(500).json({ error: 'Post failed' }); }
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json(req.user));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(process.env.PORT || 5000, () => console.log('🚀 Server Live'));
