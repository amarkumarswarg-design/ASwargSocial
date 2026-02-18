const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nickname: { type: String },
  createdAt: { type: Date, default: Date.now }
});

contactSchema.index({ owner: 1, contact: 1 }, { unique: true });

module.exports = mongoose.model('Contact', contactSchema);
