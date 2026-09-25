import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test('example.com homepage', async ({ page }, testInfo) => {
  await page.goto('https://example.com');
  await witness(page, testInfo, 'example-homepage');
});
