const mongoose = require("mongoose");

const serviceJobSchema = new mongoose.Schema({
  date: String,
  customer: { type: String, required: true },
  orderRef: String,
  problem: { type: String, required: true },
  assignedTo: String,
  appointment: String,
  status: {
    type: String,
    enum: ["Open", "In progress", "Resolved"],
    default: "Open",
  },
  chargeable: Number,
  comments: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const replacementSchema = new mongoose.Schema({
  customer: { type: String, required: true },
  originalOrderId: { type: String, required: true },
  originalItem: String,
  originalDelivered: String,
  defect: String,
  photos: [{ name: String, url: String, publicId: String }],
  newOrderId: String,
  newStage: { type: String, default: "Looking for vendor" },
  expectedDelivery: String,
  oldItemStatus: { type: String, default: "Awaiting pickup" },
  collectionDate: String,
  assignedTo: String,
  status: {
    type: String,
    enum: ["In progress", "Completed"],
    default: "In progress",
  },
  loggedDate: String,
  createdAt: { type: Date, default: Date.now },
});

const ServiceJob = mongoose.model("ServiceJob", serviceJobSchema);
const Replacement = mongoose.model("Replacement", replacementSchema);

module.exports = { ServiceJob, Replacement };
