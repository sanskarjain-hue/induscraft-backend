const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const User = require("../models/User");

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, username: user.username, name: user.name, initials: user.initials, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users — list all users (any authenticated role)
// Previously admin-only, which silently broke the salesperson dropdown in NewOrderForm
// and Pipeline for non-admin logins (fetchUsers() 403'd and was swallowed by a .catch).
// Listing names/roles is harmless for any logged-in user; only create/update/delete stay admin-only.
router.get("/users", auth, async (req, res) => {
  try {
    const users = await User.find({}).select("-password").sort({ role: 1, name: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/users — create user (admin only)
router.post("/users", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { username, password, name, role } = req.body;
    if (!username || !password || !name || !role) return res.status(400).json({ error: "All fields required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists) return res.status(409).json({ error: "Username already taken" });
    const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username: username.toLowerCase(), password: hashed, name, initials, role });
    res.status(201).json({ id: user._id, username: user.username, name: user.name, initials: user.initials, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/users/:id — update user (admin only)
router.put("/users/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { name, username, role, password } = req.body;
    const update = {};
    if (name) { update.name = name; update.initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(); }
    if (username) update.username = username.toLowerCase();
    if (role) update.role = role;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      update.password = await bcrypt.hash(password, 10);
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/users/:id — remove user (admin only)
router.delete("/users/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot delete your own account" });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/seed — run once to create all users
router.post("/seed", async (req, res) => {
  try {
    const users = [
      { username: "yash",     password: "admin123", name: "Yash Jain",    initials: "YJ", role: "admin" },
      { username: "mukesh",   password: "admin123", name: "Mukesh Jain",  initials: "MJ", role: "admin" },
      { username: "sarthak",  password: "admin123", name: "Sarthak Jain", initials: "SJ", role: "admin" },
      { username: "archana",  password: "admin123", name: "Archana Jain", initials: "AJ", role: "admin" },
      { username: "sanskar",  password: "admin123", name: "Sanskar Jain", initials: "SK", role: "admin" },
      { username: "kishore",  password: "sales123", name: "Kishore",      initials: "KR", role: "sales" },
      { username: "rajveer",  password: "sales123", name: "Rajveer",      initials: "RV", role: "sales" },
      { username: "ramesh",   password: "sales123", name: "Ramesh",       initials: "RM", role: "sales" },
      { username: "qcteam",   password: "qc123",    name: "QC Team",      initials: "QC", role: "qc" },
      { username: "accounts", password: "acc123",   name: "Accounts",     initials: "AC", role: "accountant" },
    ];
    for (const u of users) {
      const exists = await User.findOne({ username: u.username });
      if (!exists) {
        const hashed = await bcrypt.hash(u.password, 10);
        await User.create({ ...u, password: hashed });
      }
    }
    res.json({ message: "Users seeded" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;