import { test, expect } from '@playwright/test';
test('login, protected UI, navigation, theme, responsive menu and logout', async ({
  page,
}, testInfo) => {
  await page.goto('/admin/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Admin API key').fill('playwright-admin-key-123');
  await page.getByRole('button', { name: /Continue securely/ }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    await page.getByLabel('Open menu').click();
    await expect(page.getByRole('navigation')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Clients' }).click();
  await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible();
  await page.screenshot({ path: `../playwright-${testInfo.project.name}.png`, fullPage: true });
  if (testInfo.project.name === 'mobile') await page.getByLabel('Open menu').click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});
