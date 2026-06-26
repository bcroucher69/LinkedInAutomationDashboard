import { test } from '@playwright/test';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

test.setTimeout(600000); 

test('Send LinkedIn Connection Requests from Google Sheet', async ({ page, context }) => {
  // 1. Inject Authentication Cookies Directly into the Cloud Browser Context
  const liAt = process.env.LINKEDIN_LI_AT;
  const jsessionid = process.env.LINKEDIN_JSESSIONID;

  if (!liAt || !jsessionid) {
    throw new Error('❌ Missing LINKEDIN_LI_AT or LINKEDIN_JSESSIONID environment variables.');
  }

  await context.addCookies([
    { name: 'li_at', value: liAt, domain: '.linkedin.com', path: '/' },
    { name: 'JSESSIONID', value: jsessionid, domain: '.linkedin.com', path: '/' }
  ]);

  const sheetId = process.env.GOOGLE_SHEET_ID || '1BJPHPQFxN76wyDraKxXFJ95c2X7jdeKuSoFJohRoFMA';

  // ---------- Google Sheets Auth ----------
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();

  // ---------- Session Verification ----------
  console.log('Opening LinkedIn Home Page with Cloud Session...');
  await page.goto('https://www.linkedin.com');
  await page.waitForTimeout(4000);

  if (page.url().includes('login') || page.url().includes('authwall')) {
    throw new Error('❌ Authentication failed. Your cookies have expired or are invalid.');
  }
  console.log('Successfully logged in via cookies. URL:', page.url());

  // ---------- Loop through sheet rows ----------
  for (const row of rows) {
    const profileUrl = row.get('LinkedIn Contact URL');
    if (!profileUrl) continue;

    const status = row.get('Status');
    if (status === 'Connected' || status === 'Failed') continue;

    console.log(`\nProcessing: ${profileUrl}`);

    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);

      const profileHeader = page.locator('main section').first();
      const connectBtn = profileHeader.getByText('Connect', { exact: true }).first();

      if (await connectBtn.count() === 0) {
        console.log('No visible Connect button found.');
        row.set('Status', 'Skipped - No Connect Button');
        row.set('Date Processed', new Date().toISOString());
        await row.save();
        continue;
      }

      console.log('Clicking Connect button...');
      await connectBtn.click();
      await page.waitForTimeout(3000);

      // Check for weekly limit warning
      const limitToast = page.getByText(/reached the weekly limit/i);
      if (await limitToast.count() > 0) {
        console.log('⚠ Weekly connection limit reached. Stopping cloud run.');
        row.set('Status', 'Failed - Weekly Limit Reached');
        row.set('Date Processed', new Date().toISOString());
        await row.save();
        break; 
      }

      // ---------- Handle Confirmation Modal ----------
      const sendWithoutNoteBtn = page.getByRole('button', { name: 'Send without a note', exact: true }).first();

      if (await sendWithoutNoteBtn.count() > 0) {
        await sendWithoutNoteBtn.waitFor({ state: 'visible', timeout: 5000 });
        await sendWithoutNoteBtn.click();
        console.log('✓ Connection Request Sent (without note)');
        row.set('Status', 'Connected');
      } else {
        const sendBtn = page.getByRole('button', { name: 'Send', exact: true }).first();
        if (await sendBtn.count() > 0) {
          await sendBtn.click();
          console.log('✓ Connection Request Sent (with message)');
          row.set('Status', 'Connected');
        } else {
          console.log('✗ Send confirmation buttons unreachable.');
          row.set('Status', 'Failed - No Send Button');
        }
      }

      row.set('Date Processed', new Date().toISOString());
      await row.save();

      // Cloud Pace: Random 15-30s delay between profile switches
      const delay = 15000 + Math.random() * 15000;
      await page.waitForTimeout(delay);

    } catch (err) {
      console.log(`✗ Error processing ${profileUrl}`);
      row.set('Status', 'Failed - Error');
      row.set('Date Processed', new Date().toISOString());
      await row.save();
    }
  }
  console.log('All spreadsheet profiles evaluated.');
});
