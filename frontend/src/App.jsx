import { Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing';
import PatientDashboard from './pages/PatientDashboard';
import IssuerDashboard from './pages/IssuerDashboard';
import VerifyPage from './pages/VerifyPage';
import AdminDashboard from './pages/AdminDashboard';
import IssuerOnboarding from './pages/IssuerOnboarding';
import AnalyticsDashboard from './pages/AnalyticsDashboard';
import { useEffect } from 'react';
import { AuthProvider } from './hooks/useFreighter';
import { useDarkMode } from './hooks/useDarkMode';
import FreighterBanner from './components/FreighterBanner';
import DemoBanner from './components/DemoBanner';
import NavBar from './components/NavBar';
import SkipToContent from './components/SkipToContent';
import NotFoundPage from './pages/NotFoundPage';

export default function App() {
  const [dark, setDark] = useDarkMode();

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [dark]);

  return (
    <AuthProvider>
      <SkipToContent />
      <DemoBanner/>
      <NavBar dark={dark} onToggleDark={() => setDark(d => !d)} />
      <FreighterBanner />
      <main id="main-content" tabIndex={-1} style={{ outline: 'none' }}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/patient" element={<PatientDashboard />} />
          <Route path="/issuer" element={<IssuerDashboard />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/apply" element={<IssuerOnboarding />} />
          <Route path="/analytics" element={<AnalyticsDashboard />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </AuthProvider>
  );
}
