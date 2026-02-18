require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;

// Models Import
const User = require('./models/User');
const Post = require('./models/Post');
const Counter = require('./models/Counter');
const Follow = require('./models/Follow');
const Chat = require('./models/Chat');
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// Middleware - Limit badhai taaki badi photos upload ho sakein
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary Fix: Secure true zaroori hai signature ke liye
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true 
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('✅ MongoDB connected successfully'))
.catch(err => console.error('❌ MongoDB connection error:', err));

const JWT_SECRET = process.env.JWT_SECRET;

// ========== Helper: SSN Generation ==========
async function generateSSN() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'ssn' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `+1(212)908-${counter.seq.toString().padStart(4, '0')}`;
}

// ========== Auth Middleware ==========
const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized access' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
};

// ========== Socket.io: Messaging Engine ==========
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Auth error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Auth error'));
    socket.userId = decoded.id;
    next();
  });
});

io.on('connection', (socket) => {
  socket.join(socket.userId);

  socket.on('private message', async (data) => {
    try {
      const { to, content } = data;
      if(!content.trim()) return;

      // Duplicate Fix: Sirf Socket hi save karega
      let chat = await Chat.findOne({ participants: { $all: [socket.userId, to] } });
      if (!chat) {
        chat = new Chat({ participants: [socket.userId, to] });
        await chat.save();
      }

      const message = new Message({
        chat: chat._id,
        sender: socket.userId,
        content: content.trim()
      });
      await message.save();

      chat.lastMessage = message._id;
      chat.updatedAt = Date.now();
      await chat.save();

      io.to(to).emit('private message', {
        from: socket.userId,
        content: message.content,
        createdAt: message.createdAt
      });
    } catch (err) { console.error('Msg Error:', err); }
  });
});

// ========== API Routes ==========

// 1. Post Creation Fix (Cloudinary Signature Resolve)
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { content, media } = req.body;
    // Validation: Khali post nahi chalegi
    if (!content?.trim() && (!media || media.length === 0)) {
      return res.status(400).json({ error: "Post cannot be empty" });
    }

    let processedMedia = [];
    if (media && media.length > 0) {
      for (const item of media) {
        // Cloudinary Secure Upload
        const upload = await cloudinary.uploader.upload(item.url, {
          folder: 'swarg_social/posts'
        });
        processedMedia.push({ url: upload.secure_url, publicId: upload.public_id, type: 'image' });
      }
    }

    const post = new Post({ user: req.user._id, content, media: processedMedia });
    await post.save();
    await post.populate('user', 'name username profilePic');
    res.status(201).json(post);
  } catch (err) {
    console.error('Post Error:', err);
    res.status(500).json({ error: 'Server error during posting' });
  }
});

// 2. Feed Route
app.get('/api/posts/feed', authMiddleware, async (req, res) => {
  const posts = await Post.find()
    .sort({ createdAt: -1 })
    .populate('user', 'name username profilePic')
    .limit(20);
  res.json(posts);
});

// 3. User Discovery (Follow Fix)
app.get('/api/users/:identifier', authMiddleware, async (req, res) => {
  const user = await User.findOne({ 
    $or: [{ username: req.params.identifier.toLowerCase() }, { ssn: req.params.identifier }] 
  }).select('-password');
  
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [followers, following, isFollowing] = await Promise.all([
    Follow.countDocuments({ following: user._id }),
    Follow.countDocuments({ follower: user._id }),
    Follow.exists({ follower: req.user._id, following: user._id })
  ]);

  res.json({ ...user.toObject(), followersCount: followers, followingCount: following, isFollowing: !!isFollowing });
});

// Auth Routes (Registration & Login)
app.post('/api/auth/register', async (req, res) => {
    try {
      const { name, username, password, profilePic } = req.body;
      const ssn = await generateSSN();
      let picUrl = '';
  
      if (profilePic) {
        const up = await cloudinary.uploader.upload(profilePic, { folder: 'swarg_social/profiles' });
        picUrl = up.secure_url;
      }
  
      const user = new User({ name, username: username.toLowerCase(), password, ssn, profilePic: picUrl });
      await user.save();
      const token = jwt.sign({ id: user._id }, JWT_SECRET);
      res.status(201).json({ user, token });
    } catch (err) { res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { identifier, password } = req.body;
    const user = await User.findOne({ $or: [{ username: identifier.toLowerCase() }, { ssn: identifier }] });
    if (!user || !(await user.comparePassword(password))) return res.status(400).json({ error: 'Invalid details' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    res.json({ user, token });
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json(req.user));

// Catch-all
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Swarg running on port ${PORT}`));
  
