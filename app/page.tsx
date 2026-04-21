/**
 * Placeholder landing page. Real UI lands in M3 (Firebase Auth gate, dashboard,
 * audit log, settings pages). For M1 all we need is "something shows up" when
 * someone opens the root URL so the Cloud Run deploy can be verified in a
 * browser, not just with curl.
 */
export default function Home() {
  return (
    <main style={{ padding: '4rem 2rem', maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.8rem', margin: 0 }}>bt-gateway</h1>
      <p style={{ opacity: 0.7, marginTop: '0.5rem' }}>
        Multi-tenant BT Trade HTTP gateway. Web UI arrives in M3.
      </p>
      <p style={{ opacity: 0.5, marginTop: '2rem', fontSize: '0.85rem' }}>
        Health probe: <a href="/api/health" style={{ color: '#6ea8fe' }}>/api/health</a>
      </p>
    </main>
  );
}
