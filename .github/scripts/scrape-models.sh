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
    
    // Extract model names from the specific section
    const models = await page.evaluate(() => {
      const modelNames = [];
      
      // Find the "Supported AI models in Copilot" section
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      const targetHeading = headings.find(h => h.textContent.includes('Supported AI models in Copilot'));
      
      if (!targetHeading) {
        console.error('ERROR: Could not find "Supported AI models in Copilot" heading');
        return [];
      }
      
      console.error('Found target heading:', targetHeading.textContent);
      
      // Get the content section that contains this heading
      let contentSection = targetHeading.closest('div[class*="content"]') || targetHeading.parentElement;
      console.error('Content section found:', contentSection ? 'yes' : 'no');
      
      // Find all tables within this section (or after the heading)
      let tables = [];
      let currentElement = targetHeading.nextElementSibling;
      
      // Traverse siblings until we hit another h2 or run out of elements
      while (currentElement) {
        if (currentElement.tagName === 'H2') {
          break; // Stop at the next major section
        }
        
        if (currentElement.tagName === 'TABLE') {
          tables.push(currentElement);
        } else if (currentElement.querySelectorAll) {
          // Check for tables within this element
          const nestedTables = currentElement.querySelectorAll('table');
          tables.push(...nestedTables);
        }
        
        currentElement = currentElement.nextElementSibling;
      }
      
      console.error(`Found ${tables.length} tables in the target section`);
      
      tables.forEach((table, tableIndex) => {
        const rows = table.querySelectorAll('tbody tr');
        console.error(`Table ${tableIndex}: Found ${rows.length} rows`);
        
        rows.forEach((row, rowIndex) => {
          // Look for the row header (th with scope="row") which contains the model name
          const rowHeader = row.querySelector('th[scope="row"]');
          if (rowHeader) {
            let text = rowHeader.textContent.trim();
            console.error(`Table ${tableIndex}, Row ${rowIndex}: "${text}"`);
            
            if (text && text.length > 0) {
              // Normalize model name: lowercase and replace spaces with dashes
              const normalizedName = text.toLowerCase().replace(/\s+/g, '-');
              console.error(`  Normalized: "${normalizedName}"`);
              modelNames.push(normalizedName);
            }
          } else {
            // Fallback to first td if no row header exists
            const cells = row.querySelectorAll('td');
            if (cells.length > 0) {
              let text = cells[0].textContent.trim();
              console.error(`Table ${tableIndex}, Row ${rowIndex} (fallback): "${text}"`);
              
              if (text && text.length > 0) {
                // Normalize model name: lowercase and replace spaces with dashes
                const normalizedName = text.toLowerCase().replace(/\s+/g, '-');
                console.error(`  Normalized: "${normalizedName}"`);
                modelNames.push(normalizedName);
              }
            }
          }
        });
      });
      
      // Remove duplicates
      return [...new Set(modelNames)];
    });
    
    // Save only the relevant section HTML for debugging
    const relevantHTML = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      const targetHeading = headings.find(h => h.textContent.includes('Supported AI models in Copilot'));
      
      if (!targetHeading) {
        return '<p>Could not find target section</p>';
      }
      
      let html = '<h2>' + targetHeading.textContent + '</h2>\n';
      let currentElement = targetHeading.nextElementSibling;
      
      while (currentElement && currentElement.tagName !== 'H2') {
        html += currentElement.outerHTML + '\n';
        currentElement = currentElement.nextElementSibling;
      }
      
      return html;
    });
    
    fs.writeFileSync('page-content.html', relevantHTML);
    console.error('Saved relevant section HTML to page-content.html');
    
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
