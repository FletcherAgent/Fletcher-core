import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
chromium.use(stealth());

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('https://gmgn.ai/?chain=eth');
  console.log('Navigated to GMGN');
  
  try {
    const wrapper = page.locator('.cf-turnstile-wrapper, iframe[src*="turnstile"], .cf-turnstile');
    await wrapper.first().waitFor({ timeout: 5000 });
    console.log('Turnstile found!');
    
    const html = await page.content();
    const sitekeyMatch = html.match(/data-sitekey=["']([^"']+)["']/);
    console.log('Sitekey:', sitekeyMatch ? sitekeyMatch[1] : 'Not found in HTML');
  } catch(e) {
    console.log('No turnstile detected (maybe solved by stealth or we are allowed)');
  }
  
  await browser.close();
}
run();
