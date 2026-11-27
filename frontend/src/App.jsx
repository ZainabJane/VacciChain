import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Landing from './pages/Landing';
import { AuthProvider } from './hooks/useFreighter';
import { useDarkMode } from './hooks/useDarkMode';
import RoleGuard from './components/RoleGuard';
import FreighterBanner from './components/FreighterBanner';
import DemoBanner from './components/DemoBanner';
import NavBar from './components/NavBar';
import SkipToContent from './components/SkipToContent';
import ChunkErrorBoundary from './components/ChunkErrorBoundary';
import NotFoundPage from './pages/NotFoundPage';

const PatientDashboard = lazy(() => import('./pages/PatientDashboard'));
const IssuerDashboard = lazy(() => import('./pages/IssuerDashboard'));
const VerifyPage = lazy(() => import('./pages/VerifyPage'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const IssuerOnboarding = lazy(() => import('./pages/IssuerOnboarding'));
const AnalyticsDashboard = lazy(() => import('./pages/AnalyticsDashboard'));

export default function App() {
  const [dark, setDark] = useDarkMode();
  const { pathname } = useLocation();

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [dark]);

  return (
    <>
      <SkipToContent />
      <DemoBanner/>
      <NavBar dark={dark} onToggleDark={() => setDark(d => !d)} />
      <FreighterBanner />
      <main id="main-content" tabIndex={-1} style={{ outline: 'none' }}>
        <ChunkErrorBoundary key={pathname}>
        <Suspense fallback={<p role="status" style={{ textAlign: 'center', padding: '2rem' }}>Loading page…</p>}>
        <Routes>
          <Route path="/" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><Landing /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="/patient" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><PatientDashboard /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="/issuer" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><IssuerDashboard /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="/verify" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><VerifyPage /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="/admin" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><AdminDashboard /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="/apply" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><IssuerOnboarding /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="/analytics" element={
            <Suspense fallback={<Fallback />}>
              <ErrorBoundary><AnalyticsDashboard /></ErrorBoundary>
            </Suspense>
          } />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
        </ChunkErrorBoundary>
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
