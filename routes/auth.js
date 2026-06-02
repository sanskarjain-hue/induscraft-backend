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

// POST /api/auth/change-password — admin only
router.post("/change-password", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin only" });
    const { username, newPassword } = req.body;
    if (!username || !newPassword) return res.status(400).json({ error: "Username and new password required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hashed = await bcrypt.hash(newPassword, 10);
    const user = await User.findOneAndUpdate({ username }, { password: hashed }, { new: true });
    if (!user) return res.status(404).json({ error: "User not found" });
    console.log(`Password changed for ${username} by admin`);
    res.json({ success: true, username });
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
