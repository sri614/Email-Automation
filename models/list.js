const mongoose = require('mongoose');

const CreatedListSchema = new mongoose.Schema({
  name: { type: String, required: true },
  listId: { type: Number, required: true },
  createdDate: { type: Date, default: Date.now },
  deleted: { type: Boolean, default: null }
});

const CreatedList = mongoose.model('CreatedList', CreatedListSchema);
module.exports = CreatedList;