const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  initials: String,
  color: { type: String, default: "teal" },
  phone: String,
  contact: String, // Person of correspondence
  location: { type: String, default: "Jodhpur" },
  email: String,
  notes: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Vendor", vendorSchema);