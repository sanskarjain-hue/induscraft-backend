const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, name: user.name, initials: user.initials },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        initials: user.initials,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/seed — run once to create initial users
router.post("/seed", async (req, res) => {
  try {
    const existing = await User.countDocuments();
    if (existing > 0)
      return res.status(400).json({ error: "Users already seeded" });

    const users = [
      { username: "yash", password: "admin123", name: "Yash Jain", initials: "YJ", role: "admin" },
      { username: "mukesh", password: "admin123", name: "Mukesh Jain", initials: "MJ", role: "admin" },
      { username: "sarthak", password: "admin123", name: "Sarthak Jain", initials: "SJ", role: "admin" },
      { username: "archana", password: "admin123", name: "Archana Jain", initials: "AJ", role: "admin" },
      { username: "sanskar", password: "admin123", name: "Sanskar Jain", initials: "SK", role: "admin" },
      { username: "kishore", password: "sales123", name: "Kishore", initials: "KR", role: "sales" },
      { username: "rajveer", password: "sales123", name: "Rajveer", initials: "RV", role: "sales" },
      { username: "ramesh", password: "sales123", name: "Ramesh", initials: "RM", role: "sales" },
      { username: "qcteam", password: "qc123", name: "QC Team", initials: "QC", role: "qc" },
      { username: "accounts", password: "acc123", name: "Accountant", initials: "AC", role: "accountant" },
    ];

    for (const u of users) {
      const hashed = await bcrypt.hash(u.password, 10);
      await User.create({ ...u, password: hashed });
    }

    res.json({ message: `${users.length} users created successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get("/me", require("../middleware/auth"), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
