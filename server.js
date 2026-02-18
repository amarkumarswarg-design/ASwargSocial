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
const Group = require('./models/Group');
const Story = require('./models/Story');
const Contact = require('./models/Contact');

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

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error('❌ Cloudinary environment variables missing!');
} else {
  console.log('✅ Cloudinary configured');
}

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

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
  console.log('🔌 Socket connected:', socket.userId);
  socket.join(socket.userId);

  socket.on('join group', (groupId) => {
    socket.join(`group_${groupId}`);
  });

  socket.on('leave group', (groupId) => {
    socket.leave(`group_${groupId}`);
  });

  socket.on('private message', async (data) => {
    try {
      const { to, content, media } = data;
      let chat = await Chat.findOne({ participants: { $all: [socket.userId, to] } });
      if (!chat) {
        chat = new Chat({ participants: [socket.userId, to] });
        await chat.save();
      }
      const message = new Message({
        chat: chat._id,
        sender: socket.userId,
        content,
        media: media || [],
        readBy: [socket.userId]
      });
      await message.save();
      chat.lastMessage = message._id;
      chat.updatedAt = Date.now();
      await chat.save();

      // Populate sender for recipient
      await message.populate('sender', 'name username profilePic');

      io.to(to).emit('private message', {
        _id: message._id,
        from: socket.userId,
        fromName: message.sender.name,
        fromAvatar: message.sender.profilePic,
        content,
        media: message.media,
        createdAt: message.createdAt
      });
    } catch (err) {
      console.error('Socket message error:', err);
    }
  });

  socket.on('group message', async (data) => {
    try {
      const { groupId, content, media } = data;
      const group = await Group.findById(groupId);
      if (!group || !group.members.includes(socket.userId)) return;

      const message = new Message({
        group: groupId,
        sender: socket.userId,
        content,
        media: media || [],
        readBy: [socket.userId]
      });
      await message.save();
      group.lastMessage = message._id;
      group.updatedAt = Date.now();
      await group.save();

      await message.populate('sender', 'name username profilePic');

      io.to(`group_${groupId}`).emit('group message', {
        _id: message._id,
        from: socket.userId,
        fromName: message.sender.name,
        fromAvatar: message.sender.profilePic,
        content,
        media: message.media,
        createdAt: message.createdAt,
        groupId
      });
    } catch (err) {
      console.error('Socket group message error:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Socket disconnected:', socket.userId);
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
      } catch (uploadErr) {
        console.error('Cloudinary upload error:', uploadErr);
        return res.status(500).json({ error: 'Failed to upload profile picture: ' + uploadErr.message });
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
    console.error('Registration error:', err);
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
    await Story.deleteMany({ user: req.user._id });
    await Follow.deleteMany({ $or: [{ follower: req.user._id }, { following: req.user._id }] });
    await Message.deleteMany({ sender: req.user._id });
    await Chat.deleteMany({ participants: req.user._id });
    await Group.updateMany(
      { members: req.user._id },
      { $pull: { members: req.user._id, admins: req.user._id } }
    );
    await Contact.deleteMany({ $or: [{ owner: req.user._id }, { contact: req.user._id }] });
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

// ---- Contacts ----
app.get('/api/contacts', authMiddleware, async (req, res) => {
  try {
    const contacts = await Contact.find({ owner: req.user._id }).populate('contact', 'name username profilePic ssn');
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts', authMiddleware, async (req, res) => {
  try {
    const { contactSsn, nickname } = req.body;
    const contactUser = await User.findOne({ ssn: contactSsn });
    if (!contactUser) return res.status(404).json({ error: 'User not found' });
    if (contactUser._id.equals(req.user._id)) return res.status(400).json({ error: 'Cannot add yourself' });

    const existing = await Contact.findOne({ owner: req.user._id, contact: contactUser._id });
    if (existing) return res.status(400).json({ error: 'Contact already exists' });

    const contact = new Contact({
      owner: req.user._id,
      contact: contactUser._id,
      nickname: nickname || contactUser.name
    });
    await contact.save();
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:contactId', authMiddleware, async (req, res) => {
  try {
    await Contact.findOneAndDelete({ _id: req.params.contactId, owner: req.user._id });
    res.json({ message: 'Contact removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Groups ----
app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, members } = req.body; // members is array of userIds
    const allMembers = [req.user._id, ...(members || [])];
    const group = new Group({
      name,
      owner: req.user._id,
      admins: [req.user._id],
      members: allMembers
    });
    await group.save();
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user._id })
      .populate('owner', 'name username profilePic')
      .populate('admins', 'name username profilePic')
      .populate('members', 'name username profilePic')
      .populate('lastMessage');
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id })
      .populate('owner', 'name username profilePic')
      .populate('admins', 'name username profilePic')
      .populate('members', 'name username profilePic')
      .populate('lastMessage');
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/members', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(req.user._id)) return res.status(403).json({ error: 'Not authorized' });

    if (!group.members.includes(userId)) {
      group.members.push(userId);
      await group.save();
    }
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId/members/:userId', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(req.user._id) && req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    group.members = group.members.filter(id => id.toString() !== req.params.userId);
    group.admins = group.admins.filter(id => id.toString() !== req.params.userId);
    await group.save();
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/admins', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only owner can promote to admin' });
    }
    if (!group.members.includes(userId)) return res.status(400).json({ error: 'User not in group' });
    if (!group.admins.includes(userId)) {
      group.admins.push(userId);
      await group.save();
    }
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId/admins/:userId', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Only owner can demote admin' });
    }
    group.admins = group.admins.filter(id => id.toString() !== req.params.userId);
    await group.save();
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Stories ----
app.post('/api/stories', authMiddleware, async (req, res) => {
  try {
    const { media } = req.body; // base64 image
    let mediaUrl = '', mediaPublicId = '';
    if (media?.startsWith('data:image')) {
      const upload = await cloudinary.uploader.upload(media, { folder: 'swarg_social/stories' });
      mediaUrl = upload.secure_url;
      mediaPublicId = upload.public_id;
    } else {
      return res.status(400).json({ error: 'Invalid image' });
    }
    const story = new Story({
      user: req.user._id,
      media: { url: mediaUrl, publicId: mediaPublicId, type: 'image' },
      expiresAt: new Date(Date.now() + 24*60*60*1000) // 24 hours
    });
    await story.save();
    res.json(story);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stories/feed', authMiddleware, async (req, res) => {
  try {
    const following = await Follow.find({ follower: req.user._id }).distinct('following');
    following.push(req.user._id);
    const stories = await Story.find({
      user: { $in: following },
      expiresAt: { $gt: new Date() }
    }).populate('user', 'name username profilePic').sort({ createdAt: -1 });
    res.json(stories);
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
          try {
            const upload = await cloudinary.uploader.upload(item.url, {
              folder: 'swarg_social/posts',
              time
