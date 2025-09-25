const mongoose = require("mongoose");

const SegmentationSchema = new mongoose.Schema({
  campaign: { type: String, required: true },
  brand: { type: String, required: true },
  count: { type: Number, required: true },
  primaryListId: { type: Number, required: true },
  secondaryListId: { type: Number},
  sendContactListId:{type: Number,required: true},
  domain: { type: String, required: true },
  date: { type: String, required: true },
  lastMarketingEmailSentBrand: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  order: { type: Number, default: 1 } // ← required for sorting
});

const Segmentation = mongoose.model('Segmentation', SegmentationSchema);

module.exports = Segmentation;