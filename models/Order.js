const mongoose = require("mongoose");

const flagSchema = new mongoose.Schema({
  type: String,
  desc: String,
  stage: String,
  date: String,
  photos: [String],
});

const photoSchema = new mongoose.Schema({
  name: String,
  type: String,
  url: String,
  data: String, // base64 for locally uploaded
  publicId: String,
});

const itemSchema = new mongoose.Schema({
  productId: String,
  name: String,
  qty: Number,
  price: Number,
  wood: String,
  woodColour: String,
  fabricCode: String,
  hardware: [String],
  images: [photoSchema],
  measurementPhotos: [photoSchema],
  rawPhotos: [photoSchema],
  finishingPhotos: [photoSchema],
  qcPhotos: [photoSchema],
  remarks: String,
  finishingSteps: [String],
  finishingProgress: { type: Map, of: String },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
  vendorCost: { type: Number, default: 0 },
  committedDate: String,
  actualDate: String,
  stageIndex: { type: Number, default: 0 },
  originalDelivery: String,
  currentDelivery: String,
  packetCount: { type: Number, default: 0 },
  rawPhotosApproved: { type: Boolean, default: false },
  flags: [flagSchema],
  qcNotes: String,
  qcStatus: { type: String, enum: ["pass", "fail", null], default: null },
});

const paymentSchema = new mongoose.Schema({
  date: String,
  amount: Number,
  mode: String,
  ref: String,
  by: String,
  loggedAt: { type: Date, default: Date.now },
});

const dispatchSchema = new mongoose.Schema({
  partner: String,
  driver: String,
  driverPhone: String,
  courier: String,
  trackingNo: String,
  dispatchDate: String,
});

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  channel: {
    type: String,
    enum: ["Bangalore", "Pune", "Jodhpur", "Website", "Wholesale"],
    required: true,
  },
  date: String,
  salesperson: String,
  orderSheetFiles: [{ name: String, url: String, publicId: String }],
  customer: {
    name: { type: String, required: true },
    phone: String,
    address: String,
  },
  value: { type: Number, required: true },
  advance: { type: Number, default: 0 },
  notes: String,
  status: { type: String, enum: ["active", "archived"], default: "active" },
  deliveryConfirmed: { type: Boolean, default: false },
  costApproved: { type: Boolean, default: false },
  marginOverride: { type: Boolean, default: false },
  costs: { type: Map, of: Number },
  dispatchDetails: dispatchSchema,
  items: [itemSchema],
  payments: [paymentSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

orderSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Order", orderSchema);