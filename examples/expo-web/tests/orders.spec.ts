import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test('orders screen', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByTestId('track-order').waitFor();
  await witness(page, testInfo, 'orders');
});
