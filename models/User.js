const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  ssn: { type: String, required: true, unique: true },
  profilePic: { type: String, default: '' },
  profilePicPublicId: { type: String, default: '' },
  isBot: { type: Boolean, default: false },
  verified: { type: Boolean, default: false },
  ownerBadge: { type: Boolean, default: false },
  bio: { type: String, default: '' },
  work: { type: String, default: '' },
  education: { type: String, default: '' },
  location: { type: String, default: '' },
  relationship: { type: String, default: '' },
  privacy: {
    bio: { type: String, enum: ['public', 'private'], default: 'public' },
    work: { type: String, enum: ['public', 'private'], default: 'public' },
    education: { type: String, enum: ['public', 'private'], default: 'public' },
    location: { type: String, enum: ['public', 'private'], default: 'public' },
    relationship: { type: String, enum: ['public', 'private'], default: 'public' }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
