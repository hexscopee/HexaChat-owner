const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { sendOTP } = require('../config/email');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

router.post('/signup', async (req, res) => {
  try {
    const { fullName, username, email, phoneNumber, password } = req.body;

    if (!fullName || !username || !email || !phoneNumber || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const { data: existingEmail } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered.' });
    }

    const { data: existingUsername } = await supabase
      .from('users')
      .select('id')
      .eq('username', username.toLowerCase())
      .single();

    if (existingUsername) {
      return res.status(400).json({ error: 'Username already taken.' });
    }

    const { data: existingPhone } = await supabase
      .from('users')
      .select('id')
      .eq('phone_number', phoneNumber)
      .single();

    if (existingPhone) {
      return res.status(400).json({ error: 'Phone number already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        full_name: fullName,
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        phone_number: phoneNumber,
        password_hash: passwordHash,
        is_verified: false
      })
      .select()
      .single();

    if (userError) {
      return res.status(500).json({ error: 'Failed to create account. ' + userError.message });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('otps').delete().eq('email', email.toLowerCase());

    await supabase.from('otps').insert({
      email: email.toLowerCase(),
      otp,
      expires_at: expiresAt
    });

    await sendOTP(email, otp, fullName);

    res.status(201).json({
      message: 'Account created. OTP sent to your email.',
      email: email.toLowerCase(),
      userId: user.id
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error during signup.' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required.' });
    }

    const { data: otpRecord } = await supabase
      .from('otps')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('otp', otp)
      .single();

    if (!otpRecord) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    const { data: user, error: updateError } = await supabase
      .from('users')
      .update({ is_verified: true })
      .eq('email', email.toLowerCase())
      .select()
      .single();

    if (updateError || !user) {
      return res.status(500).json({ error: 'Failed to verify account.' });
    }

    await supabase.from('otps').delete().eq('email', email.toLowerCase());

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Email verified successfully!',
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        phoneNumber: user.phone_number,
        avatarUrl: user.avatar_url
      }
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Server error during verification.' });
  }
});

router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.is_verified) {
      return res.status(400).json({ error: 'Account already verified.' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('otps').delete().eq('email', email.toLowerCase());
    await supabase.from('otps').insert({
      email: email.toLowerCase(),
      otp,
      expires_at: expiresAt
    });

    await sendOTP(email, otp, user.full_name);

    res.json({ message: 'New OTP sent to your email.' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Failed to resend OTP.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .or(`username.eq.${username.toLowerCase()},email.eq.${username.toLowerCase()}`)
      .single();

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!user.is_verified) {
      return res.status(403).json({
        error: 'Account not verified. Please verify your email first.',
        email: user.email,
        needsVerification: true
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        phoneNumber: user.phone_number,
        avatarUrl: user.avatar_url
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, full_name, username, email, phone_number, avatar_url, is_online, last_seen')
      .eq('id', req.user.id)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      id: user.id,
      fullName: user.full_name,
      username: user.username,
      email: user.email,
      phoneNumber: user.phone_number,
      avatarUrl: user.avatar_url,
      isOnline: user.is_online,
      lastSeen: user.last_seen
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
