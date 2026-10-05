import { createRoot } from 'react-dom/client';
import './style.css';
import App from './App.js';
import './product-theme.css';
import { initializeAppearance } from './appearance.js';

initializeAppearance();
createRoot(document.getElementById('root')!).render(<App />);
