const mongoose = require("mongoose");

const logSchema = new mongoose.Schema({
  text: String,
  author: String,
  createdAt: { type: Date, default: Date.now },
});

const dealSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  customerPhone: String,
  customerEmail: String,
  channel: { type: String, enum: ["Bangalore", "Pune", "Jodhpur", "Website", "Wholesale"] },
  enquiry: String,
  estimatedValue: Number,
  salesperson: { type: String, required: true },
  stage: {
    type: String,
    enum: ["New Inquiry", "Warm", "Cold", "Negotiation", "Won", "Lost"],
    default: "New Inquiry",
  },
  lastContacted: String,
  lostReason: String,
  linkedOrderId: String,
  logs: [logSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

dealSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Deal", dealSchema);