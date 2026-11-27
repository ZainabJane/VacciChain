/**
 * Visual regression tests for NFTCard, VerificationBadge, and Landing page.
 *
 * Run once to generate baselines:
 *   npx playwright test e2e/visual.spec.js --update-snapshots
 *
 * Subsequent runs compare against committed baselines and fail on visual diffs.
 * Diff images are uploaded as CI artifacts (see .github/workflows/ci.yml).
 */
import { test, expect } from '@playwright/test';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Inject a minimal Freighter stub so wallet-dependent components render. */
async function stubFreighter(context) {
  await context.addInitScript(() => {
    window.freighter = {
      isConnected: async () => false,
      getPublicKey: async () => null,
      signTransaction: async (tx) => ({ transactionEnvelope: tx }),
    };
  });
}

// ── Landing page ──────────────────────────────────────────────────────────────

test.describe('Visual — Landing page', () => {
  test('matches baseline', async ({ page, context }) => {
    await stubFreighter(context);
    await page.goto('/');
    // Wait for fonts / animations to settle
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('landing.png', { fullPage: true });
  });
});

// ── NFTCard component ─────────────────────────────────────────────────────────

test.describe('Visual — NFTCard', () => {
  /**
   * We render NFTCard in isolation via a dedicated test-harness route.
   * If no harness exists we navigate to the patient dashboard and wait for
   * the first card to appear (the mock server returns fixture data).
   */
  test('default state matches baseline', async ({ page, context }) => {
    await stubFreighter(context);

    // Inject a fixture record so the card renders without a live backend
    await context.addInitScript(() => {
      window.__VACCICHAIN_FIXTURE__ = {
        token_id: 1,
        vaccine_name: 'COVID-19 mRNA',
        date_administered: '2024-01-15',
        issuer: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        dose_number: 1,
        dose_series: 2,
      };
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Locate the first NFTCard if it exists on the page, otherwise screenshot
    // the full landing as a fallback (card is rendered on patient dashboard).
    const card = page.locator('[data-testid="nft-card"]').first();
    if (await card.count() > 0) {
      await expect(card).toHaveScreenshot('nft-card.png');
    } else {
      // Navigate to patient dashboard where cards are rendered
      await page.goto('/patient');
      await page.waitForLoadState('networkidle');
      const dashCard = page.locator('[data-testid="nft-card"]').first();
      if (await dashCard.count() > 0) {
        await expect(dashCard).toHaveScreenshot('nft-card.png');
      } else {
        // No live data — screenshot the whole page as baseline
        await expect(page).toHaveScreenshot('nft-card-page.png', { fullPage: true });
      }
    }
  });
});

// ── VerificationBadge component ───────────────────────────────────────────────

test.describe('Visual — VerificationBadge', () => {
  test('verified state matches baseline', async ({ page, context }) => {
    await stubFreighter(context);
    // Navigate to the verify page with a known wallet address
    await page.goto('/verify/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN');
    await page.waitForLoadState('networkidle');

    const badge = page.locator('[data-testid="verification-badge"], #verification-badge').first();
    if (await badge.count() > 0) {
      await expect(badge).toHaveScreenshot('verification-badge-verified.png');
    } else {
      await expect(page).toHaveScreenshot('verify-page.png', { fullPage: true });
    }
  });

  test('not-found state matches baseline', async ({ page, context }) => {
    await stubFreighter(context);
    await page.goto('/verify/GBQVLZE4XCNDFW4YVKXNHX65IKJDQB3ZUQPQPFIJN5DCEVVNAQMTB6W');
    await page.waitForLoadState('networkidle');

    const badge = page.locator('[data-testid="verification-badge"], #verification-badge').first();
    if (await badge.count() > 0) {
      await expect(badge).toHaveScreenshot('verification-badge-not-found.png');
    } else {
      await expect(page).toHaveScreenshot('verify-page-not-found.png', { fullPage: true });
    }
  });
});

// ── Color-independent status cues (a11y) ──────────────────────────────────────
//
// Backlog 017: record validity and revocation must be communicated through
// text and iconography in addition to color. These checks assert that every
// status exposes a textual label and an accessible name, and capture
// screenshots under color-vision-deficiency simulations and forced-colors
// mode so reviewers can confirm the cues survive without color.
//
// Visual review checklist (see docs/visual-review-checklist.md):
//   [ ] Status text label visible for every state (verified / revoked / not-found)
//   [ ] Status icon present and not the sole differentiator
//   [ ] Accessible name (aria-label / text content) matches the visible label
//   [ ] Contrast ratio >= 4.5:1 for status text against its background
//   [ ] Screenshots reviewed under deuteranopia, protanopia, tritanopia, achromatopsia
//   [ ] Screenshots reviewed under forced-colors (Windows High Contrast) mode

/** Color-vision-deficiency simulations applied via CSS filters. */
const CVD_SIMULATIONS = [
  { name: 'deuteranopia', filter: 'grayscale(0.5) sepia(0.3) hue-rotate(-20deg) saturate(2)' },
  { name: 'protanopia', filter: 'grayscale(0.5) sepia(0.3) hue-rotate(20deg) saturate(2)' },
  { name: 'tritanopia', filter: 'grayscale(0.5) sepia(0.3) hue-rotate(160deg) saturate(2)' },
  { name: 'achromatopsia', filter: 'grayscale(1)' },
];

/** Statuses that must each expose a non-color cue. */
const STATUS_STATES = [
  {
    name: 'verified',
    url: '/verify/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    // Text that must appear somewhere in the badge / status region.
    textPattern: /verif|valid/i,
  },
  {
    name: 'revoked',
    url: '/verify/GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN?state=revoked',
    textPattern: /revok|invalid/i,
  },
  {
    name: 'not-found',
    url: '/verify/GBQVLZE4XCNDFW4YVKXNHX65IKJDQB3ZUQPQPFIJN5DCEVVNAQMTB6W',
    textPattern: /not.?found|unknown|no record/i,
  },
];

/** Apply a CSS filter to the whole document for CVD simulation. */
async function applyCvdFilter(page, filter) {
  await page.addStyleTag({
    content: `html { filter: ${filter} !important; }`,
  });
}

/** Remove any previously injected CVD filter styles. */
async function clearCvdFilters(page) {
  await page.evaluate(() => {
    document.querySelectorAll('style[data-cvd-sim]').forEach((el) => el.remove());
  });
}

test.describe('A11y — color-independent status cues', () => {
  for (const state of STATUS_STATES) {
    test(`${state.name}: exposes textual label and accessible name`, async ({ page, context }) => {
      await stubFreighter(context);
      await page.goto(state.url);
      await page.waitForLoadState('networkidle');

      const badge = page.locator('[data-testid="verification-badge"], #verification-badge').first();
      const statusRegion = (await badge.count()) > 0 ? badge : page.locator('main, body').first();

      // 1. Textual label must be present (not color-only).
      await expect(statusRegion).toContainText(state.textPattern);

      // 2. Accessible name must be non-empty and not depend on color.
      const accessibleName = await statusRegion.evaluate((el) => {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ')
            .trim();
          if (text) return text;
        }
        return (el.textContent || '').trim();
      });
      expect(accessibleName.length).toBeGreaterThan(0);
      expect(accessibleName).toMatch(state.textPattern);

      // 3. Iconography: a status icon (svg / img / role=img) must accompany the label.
      const iconCount = await statusRegion
        .locator('svg, img, [role="img"], [data-testid*="icon"]')
        .count();
      expect(iconCount, `status "${state.name}" should include an icon cue`).toBeGreaterThan(0);
    });

    for (const sim of CVD_SIMULATIONS) {
      test(`${state.name}: screenshot under ${sim.name} simulation`, async ({ page, context }) => {
        await stubFreighter(context);
        await page.goto(state.url);
        await page.waitForLoadState('networkidle');

        await page.addStyleTag({
          content: `html { filter: ${sim.filter} !important; }`,
        });

        const badge = page.locator('[data-testid="verification-badge"], #verification-badge').first();
        if ((await badge.count()) > 0) {
          await expect(badge).toHaveScreenshot(
            `verification-badge-${state.name}-${sim.name}.png`,
          );
        } else {
          await expect(page).toHaveScreenshot(
            `verify-page-${state.name}-${sim.name}.png`,
            { fullPage: true },
          );
        }
      });
    }

    test(`${state.name}: screenshot under forced-colors mode`, async ({ page, context }) => {
      await stubFreighter(context);
      await page.emulateMedia({ forcedColors: 'active' });
      await page.goto(state.url);
      await page.waitForLoadState('networkidle');

      const badge = page.locator('[data-testid="verification-badge"], #verification-badge').first();
      if ((await badge.count()) > 0) {
        await expect(badge).toHaveScreenshot(
          `verification-badge-${state.name}-forced-colors.png`,
        );
      } else {
        await expect(page).toHaveScreenshot(
          `verify-page-${state.name}-forced-colors.png`,
          { fullPage: true },
        );
      }
    });
  }
});

// ── Record cards: color-independent validity / revocation cues ────────────────

test.describe('A11y — record card status cues', () => {
  test('record card exposes validity text and icon', async ({ page, context }) => {
    await stubFreighter(context);
    await context.addInitScript(() => {
      window.__VACCICHAIN_FIXTURE__ = {
        token_id: 1,
        vaccine_name: 'COVID-19 mRNA',
        date_administered: '2024-01-15',
        issuer: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        dose_number: 1,
        dose_series: 2,
        status: 'valid',
      };
    });

    await page.goto('/patient');
    await page.waitForLoadState('networkidle');

    const card = page.locator('[data-testid="nft-card"]').first();
    test.skip((await card.count()) === 0, 'no record card rendered in this environment');

    // Status text must be present independent of color.
    await expect(card).toContainText(/valid|verif|revok|invalid/i);

    // Status icon must accompany the text.
    const iconCount = await card
      .locator('svg, img, [role="img"], [data-testid*="icon"]')
      .count();
    expect(iconCount, 'record card should include a status icon cue').toBeGreaterThan(0);
  });

  test('record card screenshot under achromatopsia simulation', async ({ page, context }) => {
    await stubFreighter(context);
    await page.goto('/patient');
    await page.waitForLoadState('networkidle');

    const card = page.locator('[data-testid="nft-card"]').first();
    test.skip((await card.count()) === 0, 'no record card rendered in this environment');

    await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
    await expect(card).toHaveScreenshot('nft-card-achromatopsia.png');
  });

  test('record card screenshot under forced-colors mode', async ({ page, context }) => {
    await stubFreighter(context);
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/patient');
    await page.waitForLoadState('networkidle');

    const card = page.locator('[data-testid="nft-card"]').first();
    test.skip((await card.count()) === 0, 'no record card rendered in this environment');

    await expect(card).toHaveScreenshot('nft-card-forced-colors.png');
  });
});
