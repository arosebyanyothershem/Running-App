// localStorage-backed persistence, mirrors the async API shape used in the original app

const PREFIX = 'ns-planner:';

export const storage = {
  async get(key) {
    try {
      const value = localStorage.getItem(PREFIX + key);
      return value === null ? null : { key, value };
    } catch {
      return null;
    }
  },

  async set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
      return { key, value };
    } catch (e) {
      console.error('Storage set failed:', e);
      return null;
    }
  },

  async delete(key) {
    try {
      localStorage.removeItem(PREFIX + key);
      return { key, deleted: true };
    } catch {
      return null;
    }
  },

  async list(prefix = '') {
    try {
      const keys = [];
      const fullPrefix = PREFIX + prefix;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(fullPrefix)) {
          keys.push(key.slice(PREFIX.length));
        }
      }
      return { keys };
    } catch {
      return { keys: [] };
    }
  },
};
