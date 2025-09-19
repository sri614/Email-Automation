const mongoose = require('mongoose');

const clonedEmailSchema = new mongoose.Schema({
  originalEmailId: {
    type: String,
    required: true,
    trim: true
  },
  clonedEmailId: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },
  clonedEmailName: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  scheduledTime: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['scheduled', 'sent', 'failed'],
    default: 'scheduled'
  },
  cloningStrategy: {
    type: String,
    enum: ['smart', 'morning', 'afternoon', 'custom'],
    default: 'smart'
  },
  // Custom HubSpot properties
  emailCategory: {
    type: String,
    default: null
  },
  mdlzBrand: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
clonedEmailSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Create compound indexes for common query patterns
clonedEmailSchema.index({ originalEmailId: 1, scheduledTime: 1 });
clonedEmailSchema.index({ status: 1, scheduledTime: 1 });

module.exports = mongoose.model('ClonedEmail', clonedEmailSchema);