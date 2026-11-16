const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const generateToken = require('../utils/generateToken');
const asyncHandler = require('../utils/asyncHandler');
const { createWelcomeNotification } = require('../services/notificationService');

const BCRYPT_ROUNDS = Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS) || 12));
// Compared against when the e-mail is unknown, so a login for a missing account takes as long as a wrong password (no account enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('fintrack-timing-equaliser', BCRYPT_ROUNDS);

// POST /api/auth/register
const registerUser = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    res.status(409);
    throw new Error('An account with this email already exists');
  }

  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  const passwordHash = await bcrypt.hash(password, salt);

  const user = await prisma.user.create({
    data: { name, email, passwordHash },
    select: { id: true, name: true, email: true, currency: true, createdAt: true },
  });

  const token = generateToken(user.id);
  await createWelcomeNotification(user.id);

  res.status(201).json({
    success: true,
    data: { user, token },
  });
});

// POST /api/auth/login
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const token = generateToken(user.id);

  res.status(200).json({
    success: true,
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        currency: user.currency,
        createdAt: user.createdAt,
      },
      token,
    },
  });
});

// GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { user: req.user } });
});

// POST /api/auth/logout
const logoutUser = asyncHandler(async (req, res) => {
  // Stateless JWT: there's nothing to invalidate server-side.
  // The frontend deletes the stored token, which is what actually "logs out" the user.
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

module.exports = { registerUser, loginUser, getMe, logoutUser };
