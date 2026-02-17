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

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } }); // Adjust CORS as needed

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from "public"
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB connection with timeout
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
  const num = counter.seq;
  const padded = num.toString().padStart(4, '0');
  return `+1(212)908-${padded}`;
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
  } catch (err) {
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
    socket.user = decoded;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.userId);
  socket.join(socket.userId);

  socket.on('private message', async (data) => {
    const { to, content, media } = data;
    try {
      // Save message to DB
      let chat = await Chat.findOne({
        participants: { $all: [socket.userId, to] }
      });
      if (!chat) {
        chat = new Chat({ participants: [socket.userId, to] });
        await chat.save();
      }
      const message = new Message({
        chat: chat._id,
        sender: socket.userId,
        content,
        media
      });
      await message.save();
      chat.lastMessage = message._id;
      chat.updatedAt = Date.now();
      await chat.save();

      // Emit to recipient
      io.to(to).emit('private message', {
        from: socket.userId,
        content,
        media,
        timestamp: message.createdAt,
        messageId: message._id
      });
    } catch (err) {
      console.error('Socket message error:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.userId);
  });
});

// ========== API Routes ==========

// ---- Auth ----
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, username, password, profilePic } = req.body;

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const ssn = await generateSSN();

    let profilePicUrl = '';
    let profilePicPublicId = '';

    if (profilePic && profilePic.startsWith('data:image')) {
      try {
        const uploadResult = await cloudinary.uploader.upload(profilePic, {
          folder: 'swarg_social/profiles',
          transformation: { width: 500, height: 500, crop: 'limit' }
        });
        profilePicUrl = uploadResult.secure_url;
        profilePicPublicId = uploadResult.public_id;
      } catch (uploadErr) {
        console.error('Cloudinary upload error:', uploadErr);
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

    const token = generateToken(user);
    res.status(201).json({ user: { ...user.toObject(), password: undefined }, token });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

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

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// ---- Users ----
app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const users = await User.find({
      username: { $regex: q, $options: 'i' }
    }).select('name username profilePic ssn').limit(20);
    // Attach follow status
    const userIds = users.map(u => u._id);
    const follows = await Follow.find({
      follower: req.user._id,
      following: { $in: userIds }
    });
    const followingSet = new Set(follows.map(f => f.following.toString()));
    const result = users.map(u => ({
      ...u.toObject(),
      isFollowing: followingSet.has(u._id.toString())
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:identifier', authMiddleware, async (req, res) => {
  try {
    const { identifier } = req.params;
    const user = await User.findOne({
      $or: [{ username: identifier.toLowerCase() }, { ssn: identifier }]
    }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Add follow counts and status
    const followersCount = await Follow.countDocuments({ following: user._id });
    const followingCount = await Follow.countDocuments({ follower: user._id });
    const isFollowing = !!(await Follow.findOne({ follower: req.user._id, following: user._id }));

    res.json({
      ...user.toObject(),
      followersCount,
      followingCount,
      isFollowing
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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

    if (updates.profilePic && updates.profilePic.startsWith('data:image')) {
      try {
        if (user.profilePicPublicId) {
          await cloudinary.uploader.destroy(user.profilePicPublicId);
        }
        const uploadResult = await cloudinary.uploader.upload(updates.profilePic, {
          folder: 'swarg_social/profiles',
          transformation: { width: 500, height: 500, crop: 'limit' }
        });
        user.profilePic = uploadResult.secure_url;
        user.profilePicPublicId = uploadResult.public_id;
      } catch (uploadErr) {
        console.error('Cloudinary upload error:', uploadErr);
        return res.status(500).json({ error: 'Failed to upload profile picture' });
      }
    }

    if (updates.password) {
      user.password = updates.password;
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
    const user = req.user;

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password' });

    if (user.profilePicPublicId) {
      await cloudinary.uploader.destroy(user.profilePicPublicId);
    }

    const posts = await Post.find({ user: user._id });
    for (const post of posts) {
      if (post.media && post.media.length > 0) {
        for (const media of post.media) {
          if (media.publicId) {
            await cloudinary.uploader.destroy(media.publicId);
          }
        }
      }
    }
    await Post.deleteMany({ user: user._id });
    await Follow.deleteMany({ $or: [{ follower: user._id }, { following: user._id }] });
    await Message.deleteMany({ sender: user._id });
    await Chat.deleteMany({ participants: user._id });
    await User.findByIdAndDelete(user._id);
    res.json({ message: 'Account deleted permanently' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Follow System ----
app.post('/api/follow/:userId', authMiddleware, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser._id.equals(req.user._id)) return res.status(400).json({ error: 'Cannot follow yourself' });

    const existing = await Follow.findOne({ follower: req.user._id, following: targetUser._id });
    if (existing) return res.status(400).json({ error: 'Already following' });

    const follow = new Follow({ follower: req.user._id, following: targetUser._id });
    await follow.save();
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

    // Upload any base64 images in media to Cloudinary
    const processedMedia = [];
    if (media && media.length > 0) {
      for (const item of media) {
        if (item.url && item.url.startsWith('data:image')) {
          const uploadResult = await cloudinary.uploader.upload(item.url, {
            folder: 'swarg_social/posts'
          });
          processedMedia.push({
            url: uploadResult.secure_url,
            publicId: uploadResult.public_id,
            type: 'image'
          });
        } else {
          processedMedia.push(item);
        }
      }
    }

    const post = new Post({
      user: req.user._id,
      content,
      media: processedMedia
    });
    await post.save();
    await post.populate('user', 'name username profilePic');
    res.status(201).json(post);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

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
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ---- Chat & Messages ----
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.user._id })
      .populate('participants', 'name username profilePic')
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    const enriched = chats.map(chat => {
      const other = chat.participants.find(p => !p._id.equals(req.user._id));
      return {
        _id: chat._id,
        otherUser: other,
        lastMessage: chat.lastMessage,
        updatedAt: chat.updatedAt
      };
    });
    res.json(enriched);
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
    const { to, content, media } = req.body;
    const recipient = await User.findById(to);
    if (!recipient) return res.status(404).json({ error: 'User not found' });

    let chat = await Chat.findOne({
      participants: { $all: [req.user._id, recipient._id] }
    });
    if (!chat) {
      chat = new Chat({ participants: [req.user._id, recipient._id] });
      await chat.save();
    }

    const message = new Message({
      chat: chat._id,
      sender: req.user._id,
      content,
      media
    });
    await message.save();

    chat.lastMessage = message._id;
    chat.updatedAt = Date.now();
    await chat.save();

    await message.populate('sender', 'name username profilePic');
    io.to(to).emit('private message', {
      from: req.user._id,
      content,
      media,
      timestamp: message.createdAt,
      messageId: message._id
    });

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Master Bot ----
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

app.post('/api/bot/broadcast', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isBot) {
      return res.status(403).json({ error: 'Only bot can broadcast' });
    }

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    io.emit('system notification', { message, from: 'Swarg Social Bot' });
    res.json({ success: true, message: 'Broadcast sent' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== Catch‑all for SPA ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== Start Server ==========
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
