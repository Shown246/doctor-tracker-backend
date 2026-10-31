import { startServer } from '../../src/server.js';

// IPC is a test-only way to deliver a termination event on Windows, where
// child.kill('SIGTERM') force-kills the process instead of invoking JS handlers.
startServer()
  .then(() => {
    const disconnectIpc = () => {
      if (process.connected) process.disconnect();
    };
    process.once('SIGINT', disconnectIpc);
    process.once('SIGTERM', disconnectIpc);
    process.send?.({ ready: true });
    process.once('message', (message: string) => {
      if (message === 'SIGINT' || message === 'SIGTERM') process.emit(message);
      disconnectIpc();
    });
  })
  .catch(() => {
    process.exitCode = 1;
    process.disconnect?.();
  });
