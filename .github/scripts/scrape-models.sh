#!/bin/bash
set -e

# Script to scrape GitHub Copilot supported models from documentation
# This script uses Puppeteer to load the page and extract model names

echo "Installing Puppeteer..."
npm install puppeteer

echo "Creating scraper script..."
cat > scrape.js << 'SCRAPE_EOF'
const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  try {
    const browser = await puppeteer.launch({ 
      headless: 'new', 
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    
    console.error('Navigating to page...');
    await page.goto('https://docs.github.com/en/copilot/reference/ai-models/supported-models', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });
    
    console.error('Content loaded, extracting models...');
    
    // Save the page HTML for debugging
    const pageContent = await page.content();
    fs.writeFileSync('page-content.html', pageContent);
    console.error('Saved page HTML to page-content.html');
    
    // Extract model names from the tables
    const models = await page.evaluate(() => {
      const modelNames = [];
      
      // Find all tables on the page
      const tables = document.querySelectorAll('table');
      console.error(`Found ${tables.length} tables`);
      
      tables.forEach((table, tableIndex) => {
        const rows = table.querySelectorAll('tbody tr');
        console.error(`Table ${tableIndex}: Found ${rows.length} rows`);
        
        rows.forEach((row, rowIndex) => {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0) {
            // Get text from first cell and clean it
            let text = cells[0].textContent.trim();
            console.error(`Table ${tableIndex}, Row ${rowIndex}: "${text}"`);
            
            if (text && text.length > 0) {
              modelNames.push(text);
            }
          }
        });
      });
      
      // Remove duplicates
      return [...new Set(modelNames)];
    });
    
    console.error(`Extracted ${models.length} unique models`);
    
    // Save models as JSON
    const modelsJson = JSON.stringify(models, null, 2);
    fs.writeFileSync('scraped-models.json', modelsJson);
    console.error('Saved scraped models to scraped-models.json');
    
    // Output for the workflow
    console.log(JSON.stringify(models));
    
    await browser.close();
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
})();
SCRAPE_EOF

echo "Running scraper..."
node scrape.js 2>&1 | tee scraper.log

# Extract the JSON output (last line)
MODELS_JSON=$(tail -n 1 scraper.log)
echo "Scraped models JSON: $MODELS_JSON"

# Store the models, one per line
echo "$MODELS_JSON" | jq -r '.[]' > models.txt
echo "Models extracted to models.txt:"
cat models.txt

echo "Scraping complete!"
