import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  getAppearance,
  initializeAppearance,
  parseAppearance,
  resolveAppearance,
  setAppearance,
  subscribeAppearance,
  type AppearanceEnvironment,
} from '../../apps/web/src/appearance.js';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});
function browser(saved: string | null = null, dark = false) {
  let stored = saved;
  const mediaListeners = new Set<() => void>();
  const storageListeners = new Set<
    (event: Pick<StorageEvent, 'key' | 'newValue' | 'storageArea'>) => void
  >();
  const root = { dataset: {}, style: { colorScheme: '' } } as AppearanceEnvironment['root'];
  const storage = {
    getItem: vi.fn(() => stored),
    setItem: vi.fn((_key: string, value: string) => {
      stored = value;
    }),
  };
  const media = {
    matches: dark,
    addEventListener: vi.fn((_type: string, listener: () => void) => mediaListeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) =>
      mediaListeners.delete(listener),
    ),
  };
  const env: AppearanceEnvironment = {
    storage,
    media: media as unknown as AppearanceEnvironment['media'],
    root,
    addStorageListener: (listener) => storageListeners.add(listener),
    removeStorageListener: (listener) => storageListeners.delete(listener),
  };
  return {
    env,
    root,
    storage,
    mediaListeners,
    storageListeners,
    systemChange(next: boolean) {
      media.matches = next;
      for (const listener of mediaListeners) listener();
    },
    storageChange(key: string | null, newValue: string | null) {
      for (const listener of storageListeners) listener({ key, newValue, storageArea: null });
    },
  };
}

describe('browser appearance preference', () => {
  it('accepts only known preferences and resolves the device choice', () => {
    expect(parseAppearance('dark')).toBe('dark');
    for (const invalid of [null, '', 'DARK', 'automatic', '<script>'])
      expect(parseAppearance(invalid)).toBe('system');
    expect(resolveAppearance('light', true)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
  });
  it('applies saved appearance synchronously before rendering and saves a local choice', () => {
    const fixture = browser('dark');
    dispose = initializeAppearance(fixture.env);
    expect(fixture.root.dataset).toMatchObject({ theme: 'dark', appearance: 'dark' });
    expect(fixture.root.style.colorScheme).toBe('dark');
    setAppearance('light');
    expect(fixture.storage.setItem).toHaveBeenLastCalledWith(APPEARANCE_STORAGE_KEY, 'light');
    expect(fixture.root.dataset.theme).toBe('light');
    expect(getAppearance()).toBe('light');
  });
  it('tracks system changes only when the user follows the device', () => {
    const fixture = browser('system');
    dispose = initializeAppearance(fixture.env);
    fixture.systemChange(true);
    expect(fixture.root.dataset.theme).toBe('dark');
    setAppearance('light');
    fixture.systemChange(false);
    fixture.systemChange(true);
    expect(fixture.root.dataset.theme).toBe('light');
    setAppearance('system');
    expect(fixture.root.dataset.theme).toBe('dark');
  });
  it('synchronizes appearance across tabs while ignoring unrelated preferences', () => {
    const fixture = browser('light', true);
    dispose = initializeAppearance(fixture.env);
    const listener = vi.fn();
    const unsubscribe = subscribeAppearance(listener);
    fixture.storageChange('listing-studio.shop', 'dark');
    expect(listener).not.toHaveBeenCalled();
    expect(fixture.root.dataset.theme).toBe('light');
    fixture.storageChange(APPEARANCE_STORAGE_KEY, 'dark');
    expect(fixture.root.dataset.theme).toBe('dark');
    expect(listener).toHaveBeenCalledOnce();
    fixture.storageChange(APPEARANCE_STORAGE_KEY, 'corrupt');
    expect(fixture.root.dataset.appearance).toBe('system');
    fixture.storageChange(null, null);
    expect(getAppearance()).toBe('system');
    unsubscribe();
  });
  it('remains usable when the browser refuses storage and cleans listeners on reinitialization', () => {
    const fixture = browser(null, true);
    fixture.storage.getItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    fixture.storage.setItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    dispose = initializeAppearance(fixture.env);
    expect(fixture.root.dataset.theme).toBe('dark');
    expect(() => setAppearance('light')).not.toThrow();
    expect(fixture.root.dataset.theme).toBe('light');
    const next = browser('dark');
    dispose = initializeAppearance(next.env);
    expect(fixture.mediaListeners.size).toBe(0);
    expect(fixture.storageListeners.size).toBe(0);
    expect(next.mediaListeners.size).toBe(1);
    dispose();
    dispose();
    expect(next.mediaListeners.size).toBe(0);
    expect(next.storageListeners.size).toBe(0);
  });
});
