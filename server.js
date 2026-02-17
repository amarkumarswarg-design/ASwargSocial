require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;

// Import models
const User = require('./models/User');
const Post = require('./models/Post');
const Counter = require('./models/Counter');
const Follow = require('./models/Follow');
const Chat = require('./models/Chat');
const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

const JWT_SECRET = process.env.JWT_SECRET;
const BOT_SECRET = process.env.BOT_SECRET;

// ========== Helper Functions ==========
async function generateSSN() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'ssn' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `+1(212)908-${counter.seq.toString().padStart(4, '0')}`;
}

function generateToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username, isBot: user.isBot },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) throw new Error();
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========== Socket.io ==========
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.userId = decoded.id;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.userId);
  socket.join(socket.userId);

  socket.on('private message', async (data) => {
    try {
      const { to, content } = data;
      // Find or create chat
      let chat = await Chat.findOne({
        participants: { $all: [socket.userId, to] }
      });
      if (!chat) {
        chat = new Chat({ participants: [socket.userId, to] });
        await chat.save();
      }
      // Save message
      const message = new Message({
        chat: chat._id,
        sender: socket.userId,
        content,
        readBy: [socket.userId] // sender has read it
      });
      await message.save();
      chat.lastMessage = message._id;
      chat.updatedAt = Date.now();
      await chat.save();

      // Emit to recipient
      io.to(to).emit('private message', {
        _id: message._id,
        from: socket.userId,
        content,
        createdAt: message.createdAt
      });
    } catch (err) {
      console.error('Socket message error:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.userId);
  });
});

// ========== API Routes ==========

// ---- Auth ----
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, username, password, profilePic } = req.body;
    if (await User.findOne({ username: username.toLowerCase() })) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const ssn = await generateSSN();
    let profilePicUrl = '', profilePicPublicId = '';

    if (profilePic?.startsWith('data:image')) {
      try {
        const upload = await cloudinary.uploader.upload(profilePic, {
          folder: 'swarg_social/profiles',
          transformation: { width: 500, height: 500, crop: 'limit' }
        });
        profilePicUrl = upload.secure_url;
        profilePicPublicId = upload.public_id;
      } catch {
        return res.status(500).json({ error: 'Failed to upload profile picture' });
      }
    }

    const user = new User({
      name,
      username: username.toLowerCase(),
      password,
      ssn,
      profilePic: profilePicUrl,
      profilePicPublicId
    });
    await user.save();

    res.status(201).json({ user: { ...user.toObject(), password: undefined }, token: generateToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findOne({
      $or: [{ username: identifier.toLowerCase() }, { ssn: identifier }]
    });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    res.json({ user: { ...user.toObject(), password: undefined }, token: generateToken(user) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json(req.user));

// ---- Users ----
app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const users = await User.find({ username: { $regex: q, $options: 'i' } })
      .select('name username profilePic ssn').limit(20);
    const following = await Follow.find({ follower: req.user._id }).distinct('following');
    const followingSet = new Set(following.map(id => id.toString()));
    res.json(users.map(u => ({ ...u.toObject(), isFollowing: followingSet.has(u._id.toString()) })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:identifier', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({
      $or: [{ username: req.params.identifier.toLowerCase() }, { ssn: req.params.identifier }]
    }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [followersCount, followingCount, isFollowing] = await Promise.all([
      Follow.countDocuments({ following: user._id }),
      Follow.countDocuments({ follower: user._id }),
      Follow.exists({ follower: req.user._id, following: user._id })
    ]);
    res.json({ ...user.toObject(), followersCount, followingCount, isFollowing: !!isFollowing });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { name, username, password, profilePic } = req.body;
    if (username && username !== user.username) {
      if (await User.findOne({ username: username.toLowerCase() })) {
        return res.status(400).json({ error: 'Username taken' });
      }
      user.username = username.toLowerCase();
    }
    if (name) user.name = name;
    if (password) user.password = password;

    if (profilePic?.startsWith('data:image')) {
      if (user.profilePicPublicId) await cloudinary.uploader.destroy(user.profilePicPublicId);
      const upload = await cloudinary.uploader.upload(profilePic, { folder: 'swarg_social/profiles' });
      user.profilePic = upload.secure_url;
      user.profilePicPublicId = upload.public_id;
    }

    user.updatedAt = Date.now();
    await user.save();
    res.json({ ...user.toObject(), password: undefined });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!(await req.user.comparePassword(password))) {
      return res.status(400).json({ error: 'Invalid password' });
    }
    // Cleanup Cloudinary
    if (req.user.profilePicPublicId) await cloudinary.uploader.destroy(req.user.profilePicPublicId);
    const posts = await Post.find({ user: req.user._id });
    for (const post of posts) {
      for (const m of post.media) if (m.publicId) await cloudinary.uploader.destroy(m.publicId);
    }
    await Post.deleteMany({ user: req.user._id });
    await Follow.deleteMany({ $or: [{ follower: req.user._id }, { following: req.user._id }] });
    await Message.deleteMany({ sender: req.user._id });
    await Chat.deleteMany({ participants: req.user._id });
    await User.findByIdAndDelete(req.user._id);
    res.json({ message: 'Account deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Follow ----
app.post('/api/follow/:userId', authMiddleware, async (req, res) => {
  try {
    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    const exists = await Follow.findOne({ follower: req.user._id, following: req.params.userId });
    if (exists) return res.status(400).json({ error: 'Already following' });
    await Follow.create({ follower: req.user._id, following: req.params.userId });
    res.json({ message: 'Followed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/follow/:userId', authMiddleware, async (req, res) => {
  try {
    await Follow.findOneAndDelete({ follower: req.user._id, following: req.params.userId });
    res.json({ message: 'Unfollowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId/followers', authMiddleware, async (req, res) => {
  try {
    const follows = await Follow.find({ following: req.params.userId }).populate('follower', 'name username profilePic ssn');
    res.json(follows.map(f => f.follower));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId/following', authMiddleware, async (req, res) => {
  try {
    const follows = await Follow.find({ follower: req.params.userId }).populate('following', 'name username profilePic ssn');
    res.json(follows.map(f => f.following));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Posts ----
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { content, media } = req.body;
    const processedMedia = [];
    if (media && media.length) {
      for (const item of media) {
        if (item.url?.startsWith('data:image')) {
          const upload = await cloudinary.uploader.upload(item.url, { folder: 'swarg_social/posts' });
          processedMedia.push({ url: upload.secure_url, publicId: upload.public_id, type: 'image' });
        } else {
          processedMedia.push(item);
        }
      }
    }
    const post = new Post({ user: req.user._id, content, media: processedMedia });
    await post.save();
    await post.populate('user', 'name username profilePic');
    res.status(201).json(post);
  } catch (err) {
    console.error('Post upload error:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

app.get('/api/posts/feed', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * 10).limit(10)
      .populate('user', 'name username profilePic')
      .populate('comments.user', 'name username profilePic');
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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

app.get('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate('user', 'name username profilePic')
      .populate('comments.user', 'name username profilePic');
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/:postId/like', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const index = post.likes.indexOf(req.user._id);
    if (index === -1) post.likes.push(req.user._id);
    else post.likes.splice(index, 1);
    await post.save();
    res.json({ likes: post.likes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/posts/:postId/comment', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Not found' });
    post.comments.push({ user: req.user._id, text: req.body.text });
    await post.save();
    await post.populate('comments.user', 'name username profilePic');
    res.json(post.comments);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/posts/:postId/comment/:commentId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    comment.remove();
    await post.save();
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Chat ----
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.user._id })
      .populate('participants', 'name username profilePic')
      .populate('lastMessage')
      .sort({ updatedAt: -1 });
    res.json(chats.map(c => {
      const other = c.participants.find(p => !p._id.equals(req.user._id));
      return { _id: c._id, otherUser: other, lastMessage: c.lastMessage, updatedAt: c.updatedAt };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findOne({ _id: req.params.chatId, participants: req.user._id });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const messages = await Message.find({ chat: chat._id }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { to, content } = req.body;
    let chat = await Chat.findOne({ participants: { $all: [req.user._id, to] } });
    if (!chat) chat = new Chat({ participants: [req.user._id, to] });
    const message = new Message({ chat: chat._id, sender: req.user._id, content, readBy: [req.user._id] });
    await message.save();
    chat.lastMessage = message._id;
    chat.updatedAt = Date.now();
    await chat.save();
    io.to(to).emit('private message', {
      _id: message._id,
      from: req.user._id,
      content,
      createdAt: message.createdAt
    });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Bot ----
app.post('/api/bot/login', async (req, res) => {
  if (req.body.password !== BOT_SECRET) return res.status(401).json({ error: 'Invalid bot credentials' });
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
  res.json({ token: generateToken(bot), user: { ...bot.toObject(), password: undefined } });
});

app.post('/api/bot/broadcast', authMiddleware, async (req, res) => {
  if (!req.user.isBot) return res.status(403).json({ error: 'Only bot can broadcast' });
  io.emit('system notification', { message: req.body.message, from: 'Swarg Social Bot' });
  res.json({ success: true });
});

// Catch‑all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
