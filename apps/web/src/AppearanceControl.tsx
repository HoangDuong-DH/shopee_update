import { useId, useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { AppearancePreference } from './appearance.js';
import { getAppearance, setAppearance, subscribeAppearance } from './appearance.js';
import './appearance.css';

export function AppearanceControl() {
  const id = useId();
  const appearance = useSyncExternalStore(
    subscribeAppearance,
    getAppearance,
    (): AppearancePreference => 'system',
  );
  const Icon = appearance === 'light' ? Sun : appearance === 'dark' ? Moon : Monitor;
  return (
    <div className="appearance-control">
      <Icon size={16} aria-hidden="true" />
      <label htmlFor={id}>Giao diện</label>
      <select
        id={id}
        value={appearance}
        onChange={(event) =>
          setAppearance(
            event.target.value === 'light'
              ? 'light'
              : event.target.value === 'dark'
                ? 'dark'
                : 'system',
          )
        }
      >
        <option value="system">Theo thiết bị</option>
        <option value="light">Sáng</option>
        <option value="dark">Tối</option>
      </select>
    </div>
  );
}
