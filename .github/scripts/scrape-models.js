/*
  Node.js script to scrape GitHub Copilot supported models.
  Outputs:
  - models.txt               (one model per line)
  - scraped-models.json      (array of model strings)
  - page-content.html        (HTML of the relevant section for debugging)
  - scraper.log              (plain log file)
*/

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const LOG_FILE = path.resolve(process.cwd(), 'scraper.log');

function resetLog() {
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch (_) {}
}

function log(...args) {
  const line = args.map(String).join(' ');
  // Write to console for Actions logs
  console.error(line);
  // Append to file for artifact
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

async function extractModels(page) {
  return page.evaluate(() => {
    const modelNames = [];

    const headings = Array.from(document.querySelectorAll('h2, h3'));
    const targetHeading = headings.find(h => h.textContent.trim().includes('Supported AI models in Copilot'));
    if (!targetHeading) return [];

    const tables = [];
    let current = targetHeading.nextElementSibling;
    while (current) {
      if (current.tagName === 'H2') {
        break;
      }
      if (current.tagName === 'TABLE') {
        tables.push(current);
      } else if (current.querySelectorAll) {
        tables.push(...current.querySelectorAll('table'));
      }
      current = current.nextElementSibling;
    }

    tables.forEach(table => {
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(row => {
        const headerCell = row.querySelector('th[scope="row"]');
        let text = '';
        if (headerCell) {
          text = headerCell.textContent.trim();
        } else {
          const firstCell = row.querySelector('td');
          if (firstCell) text = firstCell.textContent.trim();
        }
        if (text) {
          const normalized = text.toLowerCase().replace(/\s+/g, '-');
          modelNames.push(normalized);
        }
      });
    });

    return Array.from(new Set(modelNames));
  });
}

async function extractRelevantSectionHTML(page) {
  return page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h2, h3'));
    const targetHeading = headings.find(h => h.textContent.trim().includes('Supported AI models in Copilot'));
    if (!targetHeading) return '<p>Could not find target section</p>';

    let html = '<h2>' + targetHeading.textContent + '</h2>\n';
    let current = targetHeading.nextElementSibling;
    while (current && current.tagName !== 'H2') {
      html += current.outerHTML + '\n';
      current = current.nextElementSibling;
    }
    return html;
  });
}

async function main() {
  resetLog();
  log('Starting Puppeteer scrape...');

  const url = 'https://docs.github.com/en/copilot/reference/ai-models/supported-models';

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    log('Navigating to:', url);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
    log('Page loaded. Extracting models...');

    const models = await extractModels(page);
    log(`Extracted ${models.length} unique models.`);

    const relevantHTML = await extractRelevantSectionHTML(page);
    fs.writeFileSync(path.resolve(process.cwd(), 'page-content.html'), relevantHTML);
    log('Saved page-content.html');

    // Save models artifacts
    fs.writeFileSync(path.resolve(process.cwd(), 'scraped-models.json'), JSON.stringify(models, null, 2));
    log('Saved scraped-models.json');

    fs.writeFileSync(path.resolve(process.cwd(), 'models.txt'), models.join('\n'));
    log('Saved models.txt');

    // Also print JSON to stdout for optional downstream consumption
    process.stdout.write(JSON.stringify(models));
  } catch (err) {
    log('Error:', err && err.message ? err.message : String(err));
    throw err;
  } finally {
    await browser.close();
    log('Browser closed. Scrape complete.');
  }
}

main().catch(() => process.exit(1));
