const mongoose = require('mongoose');

const operationStatusSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['list_creation', 'email_clone', 'email_publish'],
    required: true
  },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed'],
    default: 'running'
  },
  startTime: {
    type: Date,
    default: Date.now
  },
  endTime: Date,
  details: {
    totalCampaigns: Number,
    processedCampaigns: Number,
    currentCampaign: String,
    estimatedCompletionTime: Date
  },
  error: String,
  user: String
});

module.exports = mongoose.model('OperationStatus', operationStatusSchema);