const { Server } = require('socket.io');

function authenticateSocket(verifyToken) {
  return (socket, next) => {
    const token = socket.handshake?.auth?.token;
    if (!token) return next(new Error('Authentication required.'));

    try {
      socket.user = verifyToken(token);
      next();
    } catch (error) {
      next(new Error('Invalid or expired session token.'));
    }
  };
}

function attachRealtime(server, { verifyToken }) {
  const io = new Server(server, {
    serveClient: true,
    transports: ['websocket', 'polling'],
  });
  io.use(authenticateSocket(verifyToken));

  let revision = Date.now();
  return {
    io,
    notifyStateChanged() {
      revision += 1;
      io.emit('state:changed', { revision });
    },
  };
}

module.exports = { attachRealtime, authenticateSocket };