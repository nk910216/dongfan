import { Route, Routes } from 'react-router-dom';
import { MockBanner } from './components/MockBanner.js';
import { StoreProvider } from './lib/store.js';
import { AddEvent } from './routes/AddEvent.js';
import { EventForm } from './routes/EventForm.js';
import { Home } from './routes/Home.js';

export function App(): React.JSX.Element {
  return (
    <StoreProvider>
      <div className="relative mx-auto flex h-full max-w-md flex-col overflow-hidden">
        <MockBanner />
        <main className="relative min-h-0 flex-1">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/add" element={<AddEvent />} />
            <Route path="/add/:typeId" element={<EventForm />} />
          </Routes>
        </main>
      </div>
    </StoreProvider>
  );
}
