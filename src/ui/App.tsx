import { useState } from 'react';

import { BrowserScreen } from './screens/BrowserScreen.js';
import { ControlScreen } from './screens/ControlScreen.js';
import { SimulationScreen } from './screens/SimulationScreen.js';
import { StatusScreen } from './screens/StatusScreen.js';

const SCREENS = [
  { name: 'status', label: 'Pipeline status', render: () => <StatusScreen /> },
  { name: 'browser', label: 'Data browser', render: () => <BrowserScreen /> },
  { name: 'control', label: 'Control', render: () => <ControlScreen /> },
  { name: 'simulation', label: 'Simulation', render: () => <SimulationScreen /> },
] as const;

type ScreenName = (typeof SCREENS)[number]['name'];

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<ScreenName>('status');

  return (
    <>
      <header>
        <h1>KILL IT TWICE</h1>
        <nav>
          {SCREENS.map(({ name, label }) => (
            <button
              key={name}
              type="button"
              aria-current={screen === name}
              onClick={() => {
                setScreen(name);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>{SCREENS.find((entry) => entry.name === screen)?.render()}</main>
    </>
  );
}
