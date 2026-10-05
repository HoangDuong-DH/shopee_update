export type AppearancePreference = 'light' | 'dark' | 'system';
export type ResolvedAppearance = Exclude<AppearancePreference, 'system'>;
export const APPEARANCE_STORAGE_KEY = 'listing-studio.appearance';

export interface AppearanceEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  media: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  root: Pick<HTMLElement, 'dataset' | 'style'>;
  addStorageListener: (
    listener: (event: Pick<StorageEvent, 'key' | 'newValue' | 'storageArea'>) => void,
  ) => void;
  removeStorageListener: (
    listener: (event: Pick<StorageEvent, 'key' | 'newValue' | 'storageArea'>) => void,
  ) => void;
}

let preference: AppearancePreference = 'system';
let environment: AppearanceEnvironment | undefined;
let currentCleanup: (() => void) | undefined;
const listeners = new Set<() => void>();

export function parseAppearance(value: string | null): AppearancePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveAppearance(
  value: AppearancePreference,
  systemDark: boolean,
): ResolvedAppearance {
  return value === 'system' ? (systemDark ? 'dark' : 'light') : value;
}
function applyAppearance(): void {
  if (!environment) return;
  const resolved = resolveAppearance(preference, environment.media.matches);
  const browserRoot = typeof document !== 'undefined' && environment.root === document.documentElement
    ? document.documentElement : undefined;
  const changing = browserRoot && browserRoot.dataset.theme && browserRoot.dataset.theme !== resolved;
  // Commit both foreground and background together. Interpolating two palettes can
  // briefly make primary button labels unreadable even when both endpoints pass.
  if (changing) browserRoot.dataset.appearanceChanging = '';
  environment.root.dataset.theme = resolved;
  environment.root.dataset.appearance = preference;
  environment.root.style.colorScheme = resolved;
  if (changing) {
    void browserRoot.offsetHeight;
    delete browserRoot.dataset.appearanceChanging;
  }
}
function notify(): void {
  for (const listener of listeners) listener();
}
export function getAppearance(): AppearancePreference {
  return preference;
}
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setAppearance(value: AppearancePreference): void {
  preference = parseAppearance(value);
  try {
    environment?.storage.setItem(APPEARANCE_STORAGE_KEY, preference);
  } catch {
    /* Privacy mode can refuse persistence; the current choice still works. */
  }
  applyAppearance();
  notify();
}
/** Run before React mounts to apply the saved preference synchronously. */
export function initializeAppearance(provided?: AppearanceEnvironment): () => void {
  currentCleanup?.();
  if (!provided && typeof window === 'undefined') return () => {};
  if (provided) environment = provided;
  else {
    // Access to localStorage itself can throw in restricted browser contexts.
    environment = {
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      },
      media: window.matchMedia('(prefers-color-scheme: dark)'),
      root: document.documentElement,
      addStorageListener: (listener) => window.addEventListener('storage', listener),
      removeStorageListener: (listener) => window.removeEventListener('storage', listener),
    };
  }
  const initializedEnvironment = environment;
  try {
    preference = parseAppearance(initializedEnvironment.storage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    preference = 'system';
  }
  applyAppearance();
  const onSystemChange = () => {
    if (preference === 'system') applyAppearance();
  };
  const onStorageChange = (event: Pick<StorageEvent, 'key' | 'newValue' | 'storageArea'>) => {
    if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
    // Ignore sessionStorage changes. A storage clear resets to the system preference.
    try {
      if (event.storageArea && !provided && event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    preference = parseAppearance(event.newValue);
    applyAppearance();
    notify();
  };
  initializedEnvironment.media.addEventListener('change', onSystemChange);
  initializedEnvironment.addStorageListener(onStorageChange);
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    initializedEnvironment.media.removeEventListener('change', onSystemChange);
    initializedEnvironment.removeStorageListener(onStorageChange);
    if (environment === initializedEnvironment) environment = undefined;
    if (currentCleanup === cleanup) currentCleanup = undefined;
  };
  currentCleanup = cleanup;
  notify();
  return cleanup;
}
