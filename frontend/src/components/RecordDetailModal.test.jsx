import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RecordDetailModal from './RecordDetailModal';

describe('RecordDetailModal', () => {
  const mockRecord = {
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15',
    token_id: '123',
    issuer: 'G12345678901234567890123456789012345678901234567890123456',
    tx_hash: 'abc123def456'
  };
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when no record is provided', () => {
    const { container } = render(<RecordDetailModal record={null} onClose={mockOnClose} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders modal with record details', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    
    expect(screen.getByText(/Vaccination Record/i)).toBeInTheDocument();
    expect(screen.getByText(/Vaccine Name/i)).toBeInTheDocument();
    expect(screen.getByText(/Date Administered/i)).toBeInTheDocument();
    expect(screen.getByText(/Token ID/i)).toBeInTheDocument();
    expect(screen.getByText(/Issuer Address/i)).toBeInTheDocument();
  });

  it('displays vaccine name', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    expect(screen.getByText(/COVID-19/i)).toBeInTheDocument();
  });

  it('displays date administered formatted for the active locale (en)', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    const expected = new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(new Date('2024-01-15T00:00:00'));
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('displays date administered formatted for the active locale (fr)', () => {
    const originalLanguage = navigator.language;
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
    try {
      render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
      const expected = new Intl.DateTimeFormat('fr', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }).format(new Date('2024-01-15T00:00:00'));
      expect(screen.getByText(expected)).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'language', {
        value: originalLanguage,
        configurable: true
      });
    }
  });

  it('shows a safe fallback for an invalid date', () => {
    const invalidRecord = { ...mockRecord, date_administered: 'not-a-date' };
    render(<RecordDetailModal record={invalidRecord} onClose={mockOnClose} />);
    expect(screen.getByText(/Date not available/i)).toBeInTheDocument();
  });

  it('shows a safe fallback when the date is missing', () => {
    const missingDateRecord = { ...mockRecord, date_administered: null };
    render(<RecordDetailModal record={missingDateRecord} onClose={mockOnClose} />);
    expect(screen.getByText(/Date not available/i)).toBeInTheDocument();
  });

  it('displays token ID', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    expect(screen.getByText(/#123/i)).toBeInTheDocument();
  });

  it('displays issuer address', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    expect(screen.getByText(/G12345678/i)).toBeInTheDocument();
  });

  it('displays transaction hash when present', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    expect(screen.getByText(/Transaction Hash/i)).toBeInTheDocument();
    expect(screen.getByText(/abc123def456/i)).toBeInTheDocument();
  });

  it('shows Stellar Explorer link when tx_hash exists', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    const link = screen.getByRole('link', { name: /View on Stellar Explorer/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('stellar.expert'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows message when no tx_hash', () => {
    const recordWithoutTx = { ...mockRecord, tx_hash: null };
    render(<RecordDetailModal record={recordWithoutTx} onClose={mockOnClose} />);
    expect(screen.getByText(/Transaction hash not available/i)).toBeInTheDocument();
  });

  it('renders close button', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    expect(screen.getByRole('button', { name: /Close modal/i })).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Close modal/i }));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', async () => {
    const user = userEvent.setup();
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    await user.keyboard('{Escape}');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('has correct role and aria attributes', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Vaccination record details');
  });

  it('moves focus into the dialog on open', () => {
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(document.activeElement);
  });

  it('constrains Tab navigation within the dialog', async () => {
    const user = userEvent.setup();
    render(<RecordDetailModal record={mockRecord} onClose={mockOnClose} />);
    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    expect(focusable.length).toBeGreaterThan(0);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the previously focused element on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open record';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(
      <RecordDetailModal record={mockRecord} onClose={mockOnClose} />
    );
    expect(trigger).not.toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();

    document.body.removeChild(trigger);
  });
});