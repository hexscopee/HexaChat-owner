require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const supabase = require('./config/supabase');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const uploadRoutes = require('./routes/upload');
const contactsRoutes = require('./routes/contacts');
const groupsRoutes = require('./routes/groups');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:5500',
      'https://hexachat1.netlify.app'  // ✅ Tumhara Netlify URL
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'https://hexachat1.netlify.app'  // ✅ Tumhara Netlify URL
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/groups', groupsRoutes);

const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

async function getUserInfo(userId) {
  const { data } = await supabase
    .from('users')
    .select('full_name, avatar_url')
    .eq('id', userId)
    .single();
  return data;
}

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, socket.id);

  supabase
    .from('users')
    .update({ is_online: true, last_seen: new Date().toISOString() })
    .eq('id', socket.userId)
    .then(() => io.emit('user_status', { userId: socket.userId, isOnline: true }));

  socket.on('send_message', async (data) => {
    try {
      const { receiverId, content, fileUrl, fileType, tempId } = data;

      const { data: message, error } = await supabase
        .from('messages')
        .insert({
          sender_id: socket.userId,
          receiver_id: receiverId,
          content: content || null,
          file_url: fileUrl || null,
          file_type: fileType || null
        })
        .select()
        .single();

      if (error) return;

      const sender = await getUserInfo(socket.userId);
      const payload = {
        ...message,
        tempId,
        senderName: sender?.full_name,
        senderAvatar: sender?.avatar_url
      };

      socket.emit('message_sent', payload);

      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('new_message', payload);
      }
    } catch (err) {
      console.error('Socket message error:', err);
    }
  });

  socket.on('send_group_message', async (data) => {
    try {
      const { groupId, content, fileUrl, fileType, tempId } = data;

      const { data: membership } = await supabase
        .from('group_members')
        .select('id')
        .eq('group_id', groupId)
        .eq('user_id', socket.userId)
        .single();

      if (!membership) return;

      const { data: message, error } = await supabase
        .from('group_messages')
        .insert({
          group_id: groupId,
          sender_id: socket.userId,
          content: content || null,
          file_url: fileUrl || null,
          file_type: fileType || null
        })
        .select()
        .single();

      if (error) return;

      const sender = await getUserInfo(socket.userId);
      const payload = {
        ...message,
        tempId,
        senderName: sender?.full_name,
        senderAvatar: sender?.avatar_url,
        reactions: []
      };

      const { data: members } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId);

      (members || []).forEach(m => {
        const sid = onlineUsers.get(m.user_id);
        if (sid) io.to(sid).emit('new_group_message', payload);
      });
    } catch (err) {
      console.error('Group message error:', err);
    }
  });

  socket.on('typing', (data) => {
    const receiverSocketId = onlineUsers.get(data.receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('user_typing', {
        userId: socket.userId,
        isTyping: data.isTyping
      });
    }
  });

  socket.on('group_typing', (data) => {
    const { groupId, isTyping } = data;
    supabase
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .then(({ data: members }) => {
        (members || []).forEach(m => {
          if (m.user_id === socket.userId) return;
          const sid = onlineUsers.get(m.user_id);
          if (sid) {
            io.to(sid).emit('group_typing', {
              groupId,
              userId: socket.userId,
              isTyping
            });
          }
        });
      });
  });

  socket.on('message_reaction', async (data) => {
    const { messageId, emoji, isGroup, groupId } = data;
    const table = isGroup ? 'group_message_reactions' : 'message_reactions';
    const event = isGroup ? 'group_reaction_update' : 'reaction_update';

    const { data: existing } = await supabase
      .from(table)
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', socket.userId)
      .eq('emoji', emoji)
      .single();

    let action;
    if (existing) {
      await supabase.from(table).delete().eq('id', existing.id);
      action = 'removed';
    } else {
      await supabase.from(table).insert({
        message_id: messageId,
        user_id: socket.userId,
        emoji
      });
      action = 'added';
    }

    const payload = { messageId, emoji, userId: socket.userId, action, groupId };

    if (isGroup && groupId) {
      const { data: members } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId);
      (members || []).forEach(m => {
        const sid = onlineUsers.get(m.user_id);
        if (sid) io.to(sid).emit(event, payload);
      });
    } else {
      io.emit(event, payload);
    }
  });

  // WebRTC signaling
  socket.on('call_user', async (data) => {
    const { targetUserId, callType, offer } = data;
    const caller = await getUserInfo(socket.userId);
    const targetSocket = onlineUsers.get(targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('incoming_call', {
        callerId: socket.userId,
        callerName: caller?.full_name,
        callerAvatar: caller?.avatar_url,
        callType,
        offer
      });
    } else {
      socket.emit('call_failed', { reason: 'User is offline.' });
    }
  });

  socket.on('call_answer', (data) => {
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('call_accepted', {
        answer: data.answer,
        userId: socket.userId
      });
    }
  });

  socket.on('call_reject', (data) => {
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('call_rejected', { userId: socket.userId });
    }
  });

  socket.on('call_end', (data) => {
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('call_ended', { userId: socket.userId });
    }
  });

  socket.on('ice_candidate', (data) => {
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('ice_candidate', {
        candidate: data.candidate,
        userId: socket.userId
      });
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.userId);
    supabase
      .from('users')
      .update({ is_online: false, last_seen: new Date().toISOString() })
      .eq('id', socket.userId)
      .then(() => io.emit('user_status', { userId: socket.userId, isOnline: false }));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/signup.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚡ HexaChat Server running on port ${PORT}\n`);
});