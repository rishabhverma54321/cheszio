import { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';

// Create context
const SocketContext = createContext();

// Server URL from environment variable.
// If not provided, default to same-origin (works with Nginx proxying /socket.io and /api).
const SERVER_URL = import.meta.env.VITE_API_URL ?? '';
console.log({ SERVER_URL })
console.log("api_url", import.meta.env.VITE_API_URL)

export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Initialize socket connection
    const socketInstance = io(SERVER_URL, {
      transports: ['websocket'],
      autoConnect: true,
    });

    // Set up event listeners
    socketInstance.on('connect', () => {
      console.log('Connected to server:', socketInstance.id);
      setConnected(true);
    });

    socketInstance.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
    });

    socketInstance.on('connect_error', (error) => {
      console.error('Connection error:', error);
      setConnected(false);
    });

    // Set socket in state
    setSocket(socketInstance);

    // Clean up on unmount
    return () => {
      socketInstance.disconnect();
    };
  }, []);

  // Value to be provided to consumers
  const value = {
    socket,
    connected
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};

// Custom hook for using the socket context
export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};
