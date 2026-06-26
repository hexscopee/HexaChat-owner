const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from('contacts')
      .select('contact_user_id, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (!rows || rows.length === 0) return res.json([]);

    const ids = rows.map(r => r.contact_user_id);
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, username, phone_number, avatar_url, is_online, last_seen')
      .in('id', ids);

    res.json((users || []).map(u => ({
      id: u.id,
      fullName: u.full_name,
      username: u.username,
      phoneNumber: u.phone_number,
      avatarUrl: u.avatar_url,
      isOnline: u.is_online,
      lastSeen: u.last_seen
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contacts.' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required.' });

    const { data: contactUser } = await supabase
      .from('users')
      .select('id, full_name, username, phone_number, avatar_url, is_online, last_seen')
      .eq('phone_number', phoneNumber)
      .single();

    if (!contactUser) return res.status(404).json({ error: 'User not found with this number.' });
    if (contactUser.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself.' });

    const { error } = await supabase.from('contacts').upsert({
      user_id: req.user.id,
      contact_user_id: contactUser.id
    }, { onConflict: 'user_id,contact_user_id' });

    if (error) return res.status(500).json({ error: 'Failed to add contact.' });

    res.status(201).json({
      id: contactUser.id,
      fullName: contactUser.full_name,
      username: contactUser.username,
      phoneNumber: contactUser.phone_number,
      avatarUrl: contactUser.avatar_url,
      isOnline: contactUser.is_online,
      lastSeen: contactUser.last_seen
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add contact.' });
  }
});

module.exports = router;
