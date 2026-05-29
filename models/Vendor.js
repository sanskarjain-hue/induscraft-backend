const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  initials: String,
  color: { type: String, default: "blue" },
  phone: String,
  location: String,
  email: String,
  notes: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Vendor", vendorSchema);
