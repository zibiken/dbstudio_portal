import { registerWelcomeRoutes } from './welcome.js';

export function registerResetRoutes(app) {
  registerWelcomeRoutes(app, { mountPath: '/reset', title: 'Reset your password' });
}
