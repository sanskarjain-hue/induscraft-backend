const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { ServiceJob, Replacement } = require("../models/AfterSales");

// ── SERVICE JOBS ──────────────────────────────────────────

// GET /api/aftersales/jobs
router.get("/jobs", auth, async (req, res) => {
  try {
    const jobs = await ServiceJob.find().sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aftersales/jobs
router.post("/jobs", auth, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const job = new ServiceJob({ ...req.body, date: today });
    await job.save();
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/aftersales/jobs/:id/status
router.patch("/jobs/:id/status", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    const job = await ServiceJob.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status, updatedAt: new Date() },
      { new: true }
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REPLACEMENTS ──────────────────────────────────────────

// GET /api/aftersales/replacements
router.get("/replacements", auth, async (req, res) => {
  try {
    const replacements = await Replacement.find().sort({ createdAt: -1 });
    res.json(replacements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aftersales/replacements
router.post("/replacements", auth, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const replacement = new Replacement({ ...req.body, loggedDate: today });
    await replacement.save();
    res.status(201).json(replacement);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/aftersales/replacements/:id
router.patch("/replacements/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    const replacement = await Replacement.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!replacement) return res.status(404).json({ error: "Replacement not found" });
    res.json(replacement);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
