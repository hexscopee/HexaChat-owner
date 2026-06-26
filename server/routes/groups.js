const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    if (!name || !memberIds || memberIds.length === 0) {
      return res.status(400).json({ error: 'Group name and at least one member required.' });
    }

    const uniqueMembers = [...new Set([req.user.id, ...memberIds])];

    const { data: group, error: groupError } = await supabase
      .from('groups')
      .insert({ name, created_by: req.user.id })
      .select()
      .single();

    if (groupError) return res.status(500).json({ error: 'Failed to create group.' });

    const memberRows = uniqueMembers.map(uid => ({
      group_id: group.id,
      user_id: uid
    }));

    await supabase.from('group_members').insert(memberRows);

    res.status(201).json({
      id: group.id,
      name: group.name,
      avatarUrl: group.avatar_url,
      type: 'group',
      memberCount: uniqueMembers.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create group.' });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data: memberships } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', req.user.id);

    if (!memberships || memberships.length === 0) return res.json([]);

    const groupIds = memberships.map(m => m.group_id);

    const { data: groups } = await supabase
      .from('groups')
      .select('id, name, avatar_url, created_at')
      .in('id', groupIds);

    const result = [];
    for (const g of groups || []) {
      const { data: lastMsg } = await supabase
        .from('group_messages')
        .select('content, file_url, created_at')
        .eq('group_id', g.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const { count } = await supabase
        .from('group_members')
        .select('*', { count: 'exact', head: true })
        .eq('group_id', g.id);

      result.push({
        id: g.id,
        name: g.name,
        avatarUrl: g.avatar_url,
        type: 'group',
        memberCount: count || 0,
        lastMessage: lastMsg ? (lastMsg.content || '📎 Attachment') : 'Group created',
        lastMessageTime: lastMsg?.created_at || g.created_at
      });
    }

    result.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load groups.' });
  }
});

router.get('/:groupId/members', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;

    const { data: members } = await supabase
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId);

    if (!members || members.length === 0) return res.json([]);

    const ids = members.map(m => m.user_id);
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, username, phone_number, avatar_url, is_online')
      .in('id', ids);

    res.json((users || []).map(u => ({
      id: u.id,
      fullName: u.full_name,
      username: u.username,
      phoneNumber: u.phone_number,
      avatarUrl: u.avatar_url,
      isOnline: u.is_online
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load members.' });
  }
});

router.get('/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;

    const { data: membership } = await supabase
      .from('group_members')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', req.user.id)
      .single();

    if (!membership) return res.status(403).json({ error: 'Not a group member.' });

    const { data: messages } = await supabase
      .from('group_messages')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });

    const msgIds = (messages || []).map(m => m.id);
    let reactions = [];
    if (msgIds.length > 0) {
      const { data: rxn } = await supabase
        .from('group_message_reactions')
        .select('*')
        .in('message_id', msgIds);
      reactions = rxn || [];
    }

    const senderIds = [...new Set((messages || []).map(m => m.sender_id))];
    let senders = {};
    if (senderIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name, avatar_url')
        .in('id', senderIds);
      (users || []).forEach(u => { senders[u.id] = u; });
    }

    const enriched = (messages || []).map(m => ({
      ...m,
      senderName: senders[m.sender_id]?.full_name,
      senderAvatar: senders[m.sender_id]?.avatar_url,
      reactions: reactions.filter(r => r.message_id === m.id)
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load group messages.' });
  }
});

module.exports = router;
