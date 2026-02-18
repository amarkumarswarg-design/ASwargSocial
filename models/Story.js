const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  media: {
    url: { type: String, required: true },
    publicId: { type: String },
    type: { type: String, enum: ['image', 'video'], default: 'image' }
  },
  viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});

storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Story', storySchema);
