const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: String,
  email: String,
  address: String,
  channel: String,
  lastOrderId: String,
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Customer", customerSchema);
