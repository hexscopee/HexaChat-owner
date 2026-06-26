const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user } = await supabase
      .from('users')
      .select('id, full_name, username, phone_number, avatar_url, is_online, last_seen')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      id: user.id,
      fullName: user.full_name,
      username: user.username,
      phoneNumber: user.phone_number,
      avatarUrl: user.avatar_url,
      isOnline: user.is_online,
      lastSeen: user.last_seen
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

router.get('/search/:phoneNumber', authMiddleware, async (req, res) => {
  try {
    const { phoneNumber } = req.params;

    const { data: user } = await supabase
      .from('users')
      .select('id, full_name, username, phone_number, avatar_url, is_online, last_seen')
      .eq('phone_number', phoneNumber)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found with this number.' });
    }

    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot chat with yourself.' });
    }

    res.json({
      id: user.id,
      fullName: user.full_name,
      username: user.username,
      phoneNumber: user.phone_number,
      avatarUrl: user.avatar_url,
      isOnline: user.is_online,
      lastSeen: user.last_seen
    });
  } catch (err) {
    res.status(500).json({ error: 'Search failed.' });
  }
});

router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: sentMessages } = await supabase
      .from('messages')
      .select('receiver_id, content, file_url, created_at, is_read')
      .eq('sender_id', userId)
      .order('created_at', { ascending: false });

    const { data: receivedMessages } = await supabase
      .from('messages')
      .select('sender_id, content, file_url, created_at, is_read')
      .eq('receiver_id', userId)
      .order('created_at', { ascending: false });

    const conversationMap = new Map();

    for (const msg of sentMessages || []) {
      if (!conversationMap.has(msg.receiver_id)) {
        conversationMap.set(msg.receiver_id, {
          partnerId: msg.receiver_id,
          lastMessage: msg.content || (msg.file_url ? '📎 Attachment' : ''),
          lastMessageTime: msg.created_at,
          unreadCount: 0
        });
      }
    }

    for (const msg of receivedMessages || []) {
      const existing = conversationMap.get(msg.sender_id);
      if (!existing || new Date(msg.created_at) > new Date(existing.lastMessageTime)) {
        conversationMap.set(msg.sender_id, {
          partnerId: msg.sender_id,
          lastMessage: msg.content || (msg.file_url ? '📎 Attachment' : ''),
          lastMessageTime: msg.created_at,
          unreadCount: existing ? existing.unreadCount : 0
        });
      }
      if (!msg.is_read) {
        const conv = conversationMap.get(msg.sender_id);
        if (conv) conv.unreadCount++;
      }
    }

    const partnerIds = Array.from(conversationMap.keys());
    if (partnerIds.length === 0) {
      return res.json([]);
    }

    const { data: partners } = await supabase
      .from('users')
      .select('id, full_name, username, phone_number, avatar_url, is_online, last_seen')
      .in('id', partnerIds);

    const conversations = (partners || []).map(partner => {
      const conv = conversationMap.get(partner.id);
      return {
        id: partner.id,
        fullName: partner.full_name,
        username: partner.username,
        phoneNumber: partner.phone_number,
        avatarUrl: partner.avatar_url,
        isOnline: partner.is_online,
        lastSeen: partner.last_seen,
        lastMessage: conv.lastMessage,
        lastMessageTime: conv.lastMessageTime,
        unreadCount: conv.unreadCount
      };
    });

    conversations.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    res.json(conversations);
  } catch (err) {
    console.error('Conversations error:', err);
    res.status(500).json({ error: 'Failed to load conversations.' });
  }
});

router.get('/messages/:partnerId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { partnerId } = req.params;

    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .or(
        `and(sender_id.eq.${userId},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${userId})`
      )
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to load messages.' });
    }

    const msgIds = (messages || []).map(m => m.id);
    let reactions = [];
    if (msgIds.length > 0) {
      const { data: rxn } = await supabase
        .from('message_reactions')
        .select('*')
        .in('message_id', msgIds);
      reactions = rxn || [];
    }

    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('sender_id', partnerId)
      .eq('receiver_id', userId)
      .eq('is_read', false);

    const enriched = (messages || []).map(m => ({
      ...m,
      reactions: reactions.filter(r => r.message_id === m.id)
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

router.post('/messages/:messageId/react', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji required.' });

    const { data: existing } = await supabase
      .from('message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .single();

    if (existing) {
      await supabase.from('message_reactions').delete().eq('id', existing.id);
      return res.json({ action: 'removed', emoji });
    }

    await supabase.from('message_reactions').insert({
      message_id: messageId,
      user_id: req.user.id,
      emoji
    });

    res.json({ action: 'added', emoji });
  } catch (err) {
    res.status(500).json({ error: 'Failed to react.' });
  }
});

router.post('/group-messages/:messageId/react', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji required.' });

    const { data: existing } = await supabase
      .from('group_message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', req.user.id)
      .eq('emoji', emoji)
      .single();

    if (existing) {
      await supabase.from('group_message_reactions').delete().eq('id', existing.id);
      return res.json({ action: 'removed', emoji });
    }

    await supabase.from('group_message_reactions').insert({
      message_id: messageId,
      user_id: req.user.id,
      emoji
    });

    res.json({ action: 'added', emoji });
  } catch (err) {
    res.status(500).json({ error: 'Failed to react.' });
  }
});

router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const { receiverId, content, fileUrl, fileType } = req.body;

    if (!receiverId || (!content && !fileUrl)) {
      return res.status(400).json({ error: 'Receiver and content/file required.' });
    }

    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        sender_id: req.user.id,
        receiver_id: receiverId,
        content: content || null,
        file_url: fileUrl || null,
        file_type: fileType || null
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to send message.' });
    }

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

module.exports = router;
