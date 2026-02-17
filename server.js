require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;

// Import models
const User = require('./models/User');
const Post = require('./models/Post');
const Counter = require('./models/Counter');

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } }); // Configure CORS as needed

// Middleware
app.use(express.json({ limit: '50mb' })); // for large payloads (DP uploads)
app.use(express.urlencoded({ extended: true }));

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET;
const BOT_SECRET = process.env.BOT_SECRET; // special password for master bot

// ========== Helper Functions ==========

// Generate a unique SSN in the format +1(212)908-xxxx
async function generateSSN() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'ssn' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const num = counter.seq;
  const padded = num.toString().padStart(4, '0');
  return `+1(212)908-${padded}`;
}

// JWT token generation
function generateToken(user) {
  return jwt.sign({ id: user._id, username: user.username, isBot: user.isBot }, JWT_SECRET, { expiresIn: '7d' });
}

// Authentication middleware
const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) throw new Error();
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== Socket.io with JWT auth ==========
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.userId = decoded.id;
    socket.user = decoded;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.userId);

  socket.join(socket.userId);

  socket.on('private message', async (data) => {
    const { to, content, media } = data;
    // Check block status (implement Block model and check)
    // Save message to DB (Message model) – to be implemented
    io.to(to).emit('private message', {
      from: socket.userId,
      content,
      media,
      timestamp: new Date()
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.userId);
  });
});

// ========== API Routes ==========

// ---- Auth ----
// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, username, password, profilePic, profilePicPublicId } = req.body;

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const ssn = await generateSSN();

    const user = new User({
      name,
      username: username.toLowerCase(),
      password,
      ssn,
      profilePic,
      profilePicPublicId
    });

    await user.save();

    const token = generateToken(user);
    res.status(201).json({ user: { ...user.toObject(), password: undefined }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login (username or SSN)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    const user = await User.findOne({
      $or: [{ username: identifier.toLowerCase() }, { ssn: identifier }]
    });

    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = generateToken(user);
    res.json({ user: { ...user.toObject(), password: undefined }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// ---- Users ----
// Search users by username (partial match)
app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const users = await User.find({
      username: { $regex: q, $options: 'i' }
    }).select('name username profilePic ssn').limit(20);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by username or SSN
app.get('/api/users/:identifier', authMiddleware, async (req, res) => {
  try {
    const { identifier } = req.params;
    const user = await User.findOne({
      $or: [{ username: identifier.toLowerCase() }, { ssn: identifier }]
    }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (name, username, password, profilePic)
app.put('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const updates = req.body;
    const user = req.user;

    if (updates.username && updates.username !== user.username) {
      const existing = await User.findOne({ username: updates.username.toLowerCase() });
      if (existing) return res.status(400).json({ error: 'Username already taken' });
      user.username = updates.username.toLowerCase();
    }

    if (updates.name) user.name = updates.name;
    if (updates.profilePic) user.profilePic = updates.profilePic;
    if (updates.profilePicPublicId) user.profilePicPublicId = updates.profilePicPublicId;
    if (updates.password) {
      user.password = updates.password; // will be hashed by pre-save
    }

    user.updatedAt = Date.now();
    await user.save();

    res.json({ ...user.toObject(), password: undefined });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete account (with password confirmation)
app.delete('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    const user = req.user;

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password' });

    await Post.deleteMany({ user: user._id });
    // Also delete from other collections (chats, groups, follows, blocks, etc.) – extend as needed

    await User.findByIdAndDelete(user._id);
    res.json({ message: 'Account deleted permanently' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Posts ----
// Create a post
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { content, media } = req.body;
    const post = new Post({
      user: req.user._id,
      content,
      media
    });
    await post.save();
    await post.populate('user', 'name username profilePic');
    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Global feed (paginated)
app.get('/api/posts/feed', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('user', 'name username profilePic')
      .populate('comments.user', 'name username profilePic');
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get posts by a specific user
app.get('/api/posts/user/:userId', authMiddleware, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.params.userId })
      .sort({ createdAt: -1 })
      .populate('user', 'name username profilePic')
      .populate('comments.user', 'name username profilePic');
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Like / Unlike a post
app.put('/api/posts/:postId/like', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const index = post.likes.indexOf(req.user._id);
    if (index === -1) {
      post.likes.push(req.user._id);
    } else {
      post.likes.splice(index, 1);
    }
    await post.save();
    res.json({ likes: post.likes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Comment on a post
app.post('/api/posts/:postId/comment', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    post.comments.push({ user: req.user._id, text });
    await post.save();
    await post.populate('comments.user', 'name username profilePic');
    res.status(201).json(post.comments);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete own comment
app.delete('/api/posts/:postId/comment/:commentId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    comment.remove();
    await post.save();
    res.json({ message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Master Bot - Special Broadcast ----
// Login as bot (uses a secret password from env)
app.post('/api/bot/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== BOT_SECRET) {
      return res.status(401).json({ error: 'Invalid bot credentials' });
    }

    let bot = await User.findOne({ isBot: true });
    if (!bot) {
      bot = new User({
        name: 'Swarg Social Bot',
        username: 'swargbot',
        password: Math.random().toString(36),
        ssn: '+1(212)908-0000',
        isBot: true
      });
      await bot.save();
    }

    const token = generateToken(bot);
    res.json({ token, user: { ...bot.toObject(), password: undefined } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Broadcast a message to all users (requires bot token)
app.post('/api/bot/broadcast', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isBot) {
      return res.status(403).json({ error: 'Only bot can broadcast' });
    }

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    // Emit to all connected sockets
    io.emit('system notification', { message, from: 'Swarg Social Bot' });

    res.json({ success: true, message: 'Broadcast sent' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== Catch‑all Route (for SPA) ==========
// This must be placed AFTER all API routes.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== Start Server ==========
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
