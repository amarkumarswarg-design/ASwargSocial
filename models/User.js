const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // Iske liye terminal mein 'npm install bcryptjs' zaroori hai

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  ssn: { type: String, unique: true },
  profilePic: { type: String, default: '' },
  profilePicPublicId: { type: String, default: '' },
  isBot: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Password save karne se pehle use encrypt (hash) karna
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Password check karne ka logic (Login ke liye)
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
                                                    
