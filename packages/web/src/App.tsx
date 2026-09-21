import { Route, Routes } from 'react-router-dom';
import { zhTW } from '@dongfan/shared';
import { Message } from './components/Message.js';
import { CreateBaby } from './routes/CreateBaby.js';
import { SessionProvider, useSession } from './lib/session.js';
import { StoreProvider } from './lib/store.js';
import { AddEvent } from './routes/AddEvent.js';
import { EditEvent } from './routes/EditEvent.js';
import { EventForm } from './routes/EventForm.js';
import { Home } from './routes/Home.js';
import { Login } from './routes/Login.js';
import { CorrectUnsynced, Unsynced } from './routes/Unsynced.js';

export function App(): React.JSX.Element {
  return (
    <SessionProvider>
      <div className="relative mx-auto flex h-full max-w-md flex-col overflow-hidden">
        <main className="relative min-h-0 flex-1">
          <Shell />
        </main>
      </div>
    </SessionProvider>
  );
}

/**
 * Chooses between signing in, making the first baby, and the app itself.
 *
 * The baby is picked here rather than inside the store, so everything below
 * can take one for granted. An account with none gets the form to make one:
 * on a freshly deployed database the owner is the only person there is, and
 * a message telling them to ask someone else would be a dead end.
 */
function Shell(): React.JSX.Element {
  const { me, loading } = useSession();

  if (loading) return <Message text={zhTW.app.loading} />;
  if (!me) return <Login />;

  const baby = me.babies[0];
  if (!baby) return <CreateBaby />;

  return (
    // Keyed by the account and the baby, so changing either builds
    // everything below from scratch. Without it a screen keeps whatever it
    // read at mount -- a queued add, a draft, a list of events -- and goes
    // on showing one family's records under another's name (spec 6.2).
    <StoreProvider key={`${me.user.id}\u0000${baby.id}`} baby={baby}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/add" element={<AddEvent />} />
        <Route path="/add/:typeId" element={<EventForm />} />
        <Route path="/event/:eventId" element={<EditEvent />} />
        <Route path="/unsynced" element={<Unsynced />} />
        <Route path="/unsynced/:eventId" element={<CorrectUnsynced />} />
      </Routes>
    </StoreProvider>
  );
}
