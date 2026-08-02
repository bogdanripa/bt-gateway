import { Link, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { useMode, type Mode } from './mode/ModeProvider';

export function Nav() {
  const { user, signOut } = useAuth();
  const { mode, setMode } = useMode();
  const pathname = useLocation().pathname;

  return (
    <div className="nav">
      <Link to="/" className="nav-brand">
        <img src="/icon.svg" alt="" width={24} height={24} />
        <span>BT Gateway</span>
      </Link>
      <Link to="/console" className={pathname === '/console' ? 'active' : ''}>Dashboard</Link>
      <Link to="/console/settings" className={pathname?.startsWith('/console/settings') ? 'active' : ''}>Settings</Link>
      <span className="spacer" />
      {user && (
        <div role="group" aria-label="Mode" style={{ display: 'flex', gap: '0.25rem' }}>
          {(['demo', 'live'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`pill ${m}`}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              style={{
                cursor: 'pointer',
                border: '1px solid transparent',
                opacity: mode === m ? 1 : 0.45,
                outline: mode === m ? '1px solid currentColor' : 'none',
                padding: '0.15rem 0.6rem',
              }}
              title={`Switch to ${m}`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      {user && <span className="user">{user.email}</span>}
      {user && (
        <button className="ghost" onClick={() => { void signOut(); }}>Sign out</button>
      )}
    </div>
  );
}
