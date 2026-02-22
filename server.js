require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');

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
const Invite = require('./models/Invite');
const Notification = require('./models/Notification'); // new

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const JWT_SECRET = process.env.JWT_SECRET;
const BOT_SECRET = process.env.BOT_SECRET;

// ========== Helpers ==========
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

  socket.on('join group', (groupId) => socket.join(`group_${groupId}`));
  socket.on('leave group', (groupId) => socket.leave(`group_${groupId}`));

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

      await message.populate('sender', 'name username profilePic verified ownerBadge');
      io.to(to).emit('private message', {
        _id: message._id,
        from: socket.userId,
        fromName: message.sender.name,
        fromAvatar: message.sender.profilePic,
        fromVerified: message.sender.verified,
        fromOwner: message.sender.ownerBadge,
        content,
        media: message.media,
        createdAt: message.createdAt
      });

      // Create notification for the recipient
      const notification = new Notification({
        user: to,
        type: 'message',
        from: socket.userId,
        post: null,
        message: `New message from ${message.sender.name}`
      });
      await notification.save();
      io.to(to).emit('new notification', { notification });
    } catch (err) {
      console.error('Socket private message error:', err);
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

      await message.populate('sender', 'name username profilePic verified ownerBadge');
      io.to(`group_${groupId}`).emit('group message', {
        _id: message._id,
        from: socket.userId,
        fromName: message.sender.name,
        fromAvatar: message.sender.profilePic,
        fromVerified: message.sender.verified,
        fromOwner: message.sender.ownerBadge,
        content,
        media: message.media,
        createdAt: message.createdAt,
        groupId
      });

      // Create notifications for group members (except sender)
      for (const memberId of group.members) {
        if (memberId.toString() !== socket.userId) {
          const notification = new Notification({
            user: memberId,
            type: 'group_message',
            from: socket.userId,
            group: groupId,
            message: `New message in ${group.name} from ${message.sender.name}`
          });
          await notification.save();
          io.to(memberId.toString()).emit('new notification', { notification });
        }
      }
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
      profilePicPublicId,
      verified: false,
      ownerBadge: false,
      bio: '',
      work: '',
      education: '',
      location: '',
      relationship: '',
      privacy: {
        bio: 'public',
        work: 'public',
        education: 'public',
        location: 'public',
        relationship: 'public'
      }
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
app.get('/api/users/all', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const users = await User.find({ _id: { $ne: req.user._id } })
      .select('name username profilePic ssn verified ownerBadge')
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const users = await User.find({ username: { $regex: q, $options: 'i' } })
      .select('name username profilePic ssn verified ownerBadge').limit(20);
    const following = await Follow.find({ follower: req.user._id }).distinct('following');
    const followingSet = new Set(following.map(id => id.toString()));
    res.json(users.map(u => ({ ...u.toObject(), isFollowing: followingSet.has(u._id.toString()) })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/suggestions', authMiddleware, async (req, res) => {
  try {
    const following = await Follow.find({ follower: req.user._id }).distinct('following');
    const followingsSet = new Set(following.map(id => id.toString()));
    followingsSet.add(req.user._id.toString());

    const suggestions = await Follow.aggregate([
      { $match: { follower: { $in: following } } },
      { $group: { _id: '$following', count: { $sum: 1 } } },
      { $match: { _id: { $nin: Array.from(followingsSet) } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const suggestedIds = suggestions.map(s => s._id);
    const users = await User.find({ _id: { $in: suggestedIds } })
      .select('name username profilePic verified ownerBadge');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:identifier', authMiddleware, async (req, res) => {
  try {
    const identifier = req.params.identifier;
    let query;

    if (mongoose.Types.ObjectId.isValid(identifier)) {
      query = { _id: identifier };
    } else {
      query = {
        $or: [
          { username: identifier.toLowerCase() },
          { ssn: identifier }
        ]
      };
    }

    const user = await User.findOne(query).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [followersCount, followingCount, isFollowing, postsCount] = await Promise.all([
      Follow.countDocuments({ following: user._id }),
      Follow.countDocuments({ follower: user._id }),
      Follow.exists({ follower: req.user._id, following: user._id }),
      Post.countDocuments({ user: user._id })
    ]);

    // Auto-verify if real followers >= 100
    if (!user.verified && !user.ownerBadge && followersCount >= 100) {
      user.verified = true;
      await user.save();
    }

    res.json({
      ...user.toObject(),
      followersCount,
      followingCount,
      isFollowing: !!isFollowing,
      postsCount
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { name, username, password, profilePic, bio, work, education, location, relationship, privacy } = req.body;

    if (username && username !== user.username) {
      if (await User.findOne({ username: username.toLowerCase() })) {
        return res.status(400).json({ error: 'Username taken' });
      }
      user.username = username.toLowerCase();
    }
    if (name) user.name = name;
    if (password) user.password = password;
    if (bio !== undefined) user.bio = bio;
    if (work !== undefined) user.work = work;
    if (education !== undefined) user.education = education;
    if (location !== undefined) user.location = location;
    if (relationship !== undefined) user.relationship = relationship;
    if (privacy) user.privacy = { ...user.privacy, ...privacy };

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
    await Notification.deleteMany({ $or: [{ user: req.user._id }, { from: req.user._id }] });
    await User.findByIdAndDelete(req.user._id);
    res.json({ message: 'Account deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Follow ----
app.post('/api/follow/:userId', authMiddleware, async (req, res) => {
  try {
    if (req.params.userId === req.user._id.toString()) return res.status(400).json({ error: 'Cannot follow yourself' });
    const exists = await Follow.findOne({ follower: req.user._id, following: req.params.userId });
    if (exists) return res.status(400).json({ error: 'Already following' });
    await Follow.create({ follower: req.user._id, following: req.params.userId });

    const followedUser = await User.findById(req.params.userId);
    const followersCount = await Follow.countDocuments({ following: followedUser._id });
    if (!followedUser.verified && !followedUser.ownerBadge && followersCount >= 100) {
      followedUser.verified = true;
      await followedUser.save();
    }

    // Create notification for followed user
    const notification = new Notification({
      user: req.params.userId,
      type: 'follow',
      from: req.user._id,
      message: `${req.user.name} started following you`
    });
    await notification.save();
    io.to(req.params.userId).emit('new notification', { notification });

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
    const follows = await Follow.find({ following: req.params.userId }).populate('follower', 'name username profilePic ssn verified ownerBadge');
    res.json(follows.map(f => f.follower));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId/following', authMiddleware, async (req, res) => {
  try {
    const follows = await Follow.find({ follower: req.params.userId }).populate('following', 'name username profilePic ssn verified ownerBadge');
    res.json(follows.map(f => f.following));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Notifications ----
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user._id })
      .populate('from', 'name username profilePic verified ownerBadge')
      .populate('post', 'content media')
      .populate('group', 'name dp')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { read: true });
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
    res.json({ message: 'All marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Contacts ----
app.get('/api/contacts', authMiddleware, async (req, res) => {
  try {
    const contacts = await Contact.find({ owner: req.user._id }).populate('contact', 'name username profilePic ssn verified ownerBadge');
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
    const { name, members } = req.body;
    const allMembers = [req.user._id, ...(members || [])];
    const group = new Group({
      name,
      owner: req.user._id,
      admins: [req.user._id],
      members: allMembers
    });
    await group.save();

    // Notify added members
    for (const memberId of allMembers) {
      if (memberId.toString() !== req.user._id) {
        const notification = new Notification({
          user: memberId,
          type: 'group_add',
          from: req.user._id,
          group: group._id,
          message: `You were added to group ${name}`
        });
        await notification.save();
        io.to(memberId.toString()).emit('new notification', { notification });
      }
    }

    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user._id })
      .populate('owner', 'name username profilePic verified ownerBadge')
      .populate('admins', 'name username profilePic verified ownerBadge')
      .populate('members', 'name username profilePic verified ownerBadge')
      .populate('lastMessage');
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id })
      .populate('owner', 'name username profilePic verified ownerBadge')
      .populate('admins', 'name username profilePic verified ownerBadge')
      .populate('members', 'name username profilePic verified ownerBadge')
      .populate('lastMessage');
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const { name, dp } = req.body;
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(req.user._id)) return res.status(403).json({ error: 'Not authorized' });

    if (name) group.name = name;
    if (dp && dp.startsWith('data:image')) {
      if (group.dpPublicId) await cloudinary.uploader.destroy(group.dpPublicId);
      const upload = await cloudinary.uploader.upload(dp, { folder: 'swarg_social/groups' });
      group.dp = upload.secure_url;
      group.dpPublicId = upload.public_id;
    }
    await group.save();
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

      const notification = new Notification({
        user: userId,
        type: 'group_add',
        from: req.user._id,
        group: group._id,
        message: `You were added to group ${group.name}`
      });
      await notification.save();
      io.to(userId).emit('new notification', { notification });
    }
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId/members/:userId', authMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(req.user._id) && req.user._id.toString() !== req.params.userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    group.members = group.members.filter(id => id.toString() !== req.params.userId);
    group.admins = group.admins.filter(id => id.toString() !== req.params.userId);
    await group.save();

    // Notify removed user via bot (if bot exists)
    const bot = await User.findOne({ isBot: true });
    if (bot) {
      const message = new Message({
        chat: null,
        group: null,
        sender: bot._id,
        content: `You were removed from group "${group.name}"${reason ? ` because: ${reason}` : ''}.`,
        readBy: [bot._id]
      });
      await message.save();
      io.to(req.params.userId).emit('private message', {
        _id: message._id,
        from: bot._id,
        fromName: bot.name,
        fromAvatar: bot.profilePic,
        content: message.content,
        media: [],
        createdAt: message.createdAt
      });
    }

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
    if (group.owner.toString() !== req.user._id.toString()) return res.status(403).json({ error: 'Only owner can promote to admin' });
    if (!group.members.includes(userId)) return res.status(400).json({ error: 'User not in group' });
    if (!group.admins.includes(userId)) {
      group.admins.push(userId);
      await group.save();

      const notification = new Notification({
        user: userId,
        type: 'group_admin',
        from: req.user._id,
        group: group._id,
        message: `You were made admin in group ${group.name}`
      });
      await notification.save();
      io.to(userId).emit('new notification', { notification });
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
    if (group.owner.toString() !== req.user._id.toString()) return res.status(403).json({ error: 'Only owner can demote admin' });
    group.admins = group.admins.filter(id => id.toString() !== req.params.userId);
    await group.save();

    const notification = new Notification({
      user: req.params.userId,
      type: 'group_admin',
      from: req.user._id,
      group: group._id,
      message: `You were removed as admin from group ${group.name}`
    });
    await notification.save();
    io.to(req.params.userId).emit('new notification', { notification });

    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/invite', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(req.user._id)) return res.status(403).json({ error: 'Not authorized' });

    const code = crypto.randomBytes(8).toString('hex');
    const invite = new Invite({
      groupId: group._id,
      code,
      expiresAt: new Date(Date.now() + 7*24*60*60*1000)
    });
    await invite.save();
    res.json({ inviteLink: `${req.protocol}://${req.get('host')}/join/${code}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/join/:code', async (req, res) => {
  try {
    const invite = await Invite.findOne({ code: req.params.code, expiresAt: { $gt: new Date() } });
    if (!invite) return res.status(404).send('Invite expired or invalid');
    res.redirect(`/?joinGroup=${invite.groupId}`);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.delete('/api/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, owner: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found or not owner' });
    await Group.findByIdAndDelete(group._id);
    res.json({ message: 'Group deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Stories ----
app.post('/api/stories', authMiddleware, async (req, res) => {
  try {
    const { media } = req.body;
    if (!media?.startsWith('data:image')) return res.status(400).json({ error: 'Invalid image' });
    const upload = await cloudinary.uploader.upload(media, { folder: 'swarg_social/stories' });
    const story = new Story({
      user: req.user._id,
      media: { url: upload.secure_url, publicId: upload.public_id, type: 'image' },
      expiresAt: new Date(Date.now() + 24*60*60*1000)
    });
    await story.save();

    // Notify followers
    const followers = await Follow.find({ following: req.user._id }).distinct('follower');
    for (const followerId of followers) {
      const notification = new Notification({
        user: followerId,
        type: 'story',
        from: req.user._id,
        message: `${req.user.name} posted a story`
      });
      await notification.save();
      io.to(followerId.toString()).emit('new notification', { notification });
    }

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
    }).populate('user', 'name username profilePic verified ownerBadge').sort({ createdAt: -1 });
    res.json(stories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stories/:storyId/like', authMiddleware, async (req, res) => {
  try {
    const story = await Story.findById(req.params.storyId);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    const index = story.viewers.indexOf(req.user._id);
    if (index === -1) {
      story.viewers.push(req.user._id);
    } else {
      story.viewers.splice(index, 1);
    }
    await story.save();

    // Notify story owner if liked
    if (index === -1 && story.user.toString() !== req.user._id) {
      const notification = new Notification({
        user: story.user,
        type: 'story_like',
        from: req.user._id,
        message: `${req.user.name} liked your story`
      });
      await notification.save();
      io.to(story.user.toString()).emit('new notification', { notification });
    }

    res.json({ viewers: story.viewers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stories/:storyId', authMiddleware, async (req, res) => {
  try {
    const story = await Story.findById(req.params.storyId);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (story.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (story.media.publicId) await cloudinary.uploader.destroy(story.media.publicId);
    await story.deleteOne();
    res.json({ message: 'Story deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Posts ----
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { content, media } = req.body;
    const processedMedia = [];
    if (media?.length) {
      for (const item of media) {
        if (item.url?.startsWith('data:image')) {
          try {
            const upload = await cloudinary.uploader.upload(item.url, {
              folder: 'swarg_social/posts',
              timeout: 60000
            });
            processedMedia.push({ url: upload.secure_url, publicId: upload.public_id, type: 'image' });
          } catch (uploadErr) {
            console.error('Cloudinary upload error:', uploadErr);
            return res.status(500).json({ error: 'Image upload failed: ' + uploadErr.message });
          }
        } else {
          processedMedia.push(item);
        }
      }
    }
    const post = new Post({ user: req.user._id, content, media: processedMedia });
    await post.save();
    await post.populate('user', 'name username profilePic verified ownerBadge');

    // Notify followers
    const followers = await Follow.find({ following: req.user._id }).distinct('follower');
    for (const followerId of followers) {
      const notification = new Notification({
        user: followerId,
        type: 'post',
        from: req.user._id,
        post: post._id,
        message: `${req.user.name} posted something new`
      });
      await notification.save();
      io.to(followerId.toString()).emit('new notification', { notification });
    }

    res.status(201).json(post);
  } catch (err) {
    console.error('Post creation error:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

app.get('/api/posts/feed', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * 10).limit(10)
      .populate('user', 'name username profilePic verified ownerBadge')
      .populate('comments.user', 'name username profilePic verified ownerBadge');
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/posts/user/:userId', authMiddleware, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.params.userId })
      .sort({ createdAt: -1 })
      .populate('user', 'name username profilePic verified ownerBadge')
      .populate('comments.user', 'name username profilePic verified ownerBadge');
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate('user', 'name username profilePic verified ownerBadge')
      .populate('comments.user', 'name username profilePic verified ownerBadge');
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
    if (index === -1) {
      post.likes.push(req.user._id);
    } else {
      post.likes.splice(index, 1);
    }
    await post.save();

    // Notify post owner if liked
    if (index === -1 && post.user.toString() !== req.user._id) {
      const notification = new Notification({
        user: post.user,
        type: 'like',
        from: req.user._id,
        post: post._id,
        message: `${req.user.name} liked your post`
      });
      await notification.save();
      io.to(post.user.toString()).emit('new notification', { notification });
    }

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
    await post.populate('comments.user', 'name username profilePic verified ownerBadge');

    // Notify post owner if commented
    if (post.user.toString() !== req.user._id) {
      const notification = new Notification({
        user: post.user,
        type: 'comment',
        from: req.user._id,
        post: post._id,
        message: `${req.user.name} commented on your post: "${req.body.text.substring(0,30)}${req.body.text.length>30?'...':''}"`
      });
      await notification.save();
      io.to(post.user.toString()).emit('new notification', { notification });
    }

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

app.delete('/api/posts/:postId', authMiddleware, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    for (const m of post.media) {
      if (m.publicId) await cloudinary.uploader.destroy(m.publicId);
    }
    await post.deleteOne();
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Chat & Messages ----
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.user._id })
      .populate('participants', 'name username profilePic verified ownerBadge')
      .populate('lastMessage')
      .sort({ updatedAt: -1 });
    // Get unread counts
    const chatIds = chats.map(c => c._id);
    const unreadCounts = await Message.aggregate([
      { $match: { chat: { $in: chatIds }, readBy: { $ne: req.user._id } } },
      { $group: { _id: '$chat', count: { $sum: 1 } } }
    ]);
    const unreadMap = {};
    unreadCounts.forEach(u => unreadMap[u._id] = u.count);

    res.json(chats.map(c => {
      const other = c.participants.find(p => !p._id.equals(req.user._id));
      return {
        _id: c._id,
        otherUser: other,
        lastMessage: c.lastMessage,
        updatedAt: c.updatedAt,
        unreadCount: unreadMap[c._id] || 0
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findOne({ _id: req.params.chatId, participants: req.user._id });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const messages = await Message.find({ chat: chat._id })
      .populate('sender', 'name username profilePic verified ownerBadge')
      .sort({ createdAt: 1 });
    // Mark messages as read
    await Message.updateMany(
      { chat: chat._id, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const group = await Group.findOne({ _id: req.params.groupId, members: req.user._id });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const messages = await Message.find({ group: group._id })
      .populate('sender', 'name username profilePic verified ownerBadge')
      .sort({ createdAt: 1 });
    // Mark messages as read
    await Message.updateMany(
      { group: group._id, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    // Check if user is sender, group admin, or group owner
    if (message.sender.toString() === req.user._id.toString()) {
      // sender can delete
    } else if (message.group) {
      const group = await Group.findById(message.group);
      if (!group) return res.status(404).json({ error: 'Group not found' });
      if (!group.admins.includes(req.user._id) && group.owner.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Not authorized' });
      }
    } else {
      return res.status(403).json({ error: 'Not authorized' });
    }
    await message.deleteOne();
    // Notify group members to remove message from UI
    if (message.group) {
      io.to(`group_${message.group}`).emit('message deleted', { messageId: message._id });
    } else if (message.chat) {
      const chat = await Chat.findById(message.chat);
      if (chat) {
        const other = chat.participants.find(p => p.toString() !== req.user._id.toString());
        if (other) {
          io.to(other.toString()).emit('message deleted', { messageId: message._id });
        }
      }
    }
    res.json({ message: 'Message deleted' });
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
      isBot: true,
      verified: true,
      ownerBadge: false
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

// Catch‑all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
