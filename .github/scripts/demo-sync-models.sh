#!/bin/bash
# Demo script for the automated model syncing workflow
# This demonstrates how the check-models.yml workflow syncs model data

set -e

echo "🎬 GitHub Copilot Model Sync Demo"
echo "=================================="
echo ""
echo "This demo shows how the automated workflow keeps model data up-to-date."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Navigate to repo root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo -e "${BLUE}Step 1: Create sample scraped data${NC}"
echo "   In production, this would come from scraping GitHub's documentation"
echo ""

# Create sample scraped data with a few new models
cat > .github/scripts/scraped-models.json << 'EOF'
[
  "gpt-4",
  "gpt-4o",
  "gpt-4o-mini",
  "claude-sonnet-3.5",
  "claude-sonnet-4",
  "gemini-2.0-flash",
  "o3-mini",
  "o4-mini",
  "demo-model-new-1",
  "demo-model-new-2"
]
EOF

echo -e "${GREEN}✓ Created sample data with 10 models (2 are new)${NC}"
cat .github/scripts/scraped-models.json
echo ""

echo -e "${BLUE}Step 2: Analyze current model data files${NC}"
echo "   Checking tokenEstimators.json and modelPricing.json"
echo ""

# Count current models
ESTIMATOR_COUNT=$(jq '.estimators | length' src/tokenEstimators.json)
PRICING_COUNT=$(jq '.pricing | length' src/modelPricing.json)

echo -e "   Current models in tokenEstimators.json: ${YELLOW}${ESTIMATOR_COUNT}${NC}"
echo -e "   Current models in modelPricing.json: ${YELLOW}${PRICING_COUNT}${NC}"
echo ""

echo -e "${BLUE}Step 3: Identify missing models${NC}"
echo "   Comparing scraped models with existing configuration"
echo ""

# Create a simple comparison script
cat > /tmp/compare-models.js << 'COMPARE_EOF'
const fs = require('fs');

const scraped = JSON.parse(fs.readFileSync('.github/scripts/scraped-models.json', 'utf8'));
const estimators = JSON.parse(fs.readFileSync('src/tokenEstimators.json', 'utf8'));
const pricing = JSON.parse(fs.readFileSync('src/modelPricing.json', 'utf8'));

const missingFromEstimators = scraped.filter(m => !estimators.estimators[m]);
const missingFromPricing = scraped.filter(m => !pricing.pricing[m]);

console.log('Missing from tokenEstimators.json:', missingFromEstimators);
console.log('Missing from modelPricing.json:', missingFromPricing);

// Output for demo
process.stdout.write(JSON.stringify({
  missingEstimators: missingFromEstimators,
  missingPricing: missingFromPricing
}, null, 2));
COMPARE_EOF

MISSING=$(node /tmp/compare-models.js 2>&1 | tail -n +3)
echo "$MISSING"
echo ""

echo -e "${BLUE}Step 4: Update model configuration files${NC}"
echo "   Adding missing models with default values"
echo ""

# Create backup
cp src/tokenEstimators.json src/tokenEstimators.json.backup
cp src/modelPricing.json src/modelPricing.json.backup

# Add the demo models
cat > /tmp/update-models.js << 'UPDATE_EOF'
const fs = require('fs');

const scraped = JSON.parse(fs.readFileSync('.github/scripts/scraped-models.json', 'utf8'));
const estimators = JSON.parse(fs.readFileSync('src/tokenEstimators.json', 'utf8'));
const pricing = JSON.parse(fs.readFileSync('src/modelPricing.json', 'utf8'));

let estimatorChanges = 0;
let pricingChanges = 0;

// Add missing models to estimators
scraped.forEach(model => {
  if (!estimators.estimators[model]) {
    estimators.estimators[model] = 0.25; // Default ratio
    estimatorChanges++;
    console.log(`   ✓ Added ${model} to tokenEstimators.json (ratio: 0.25)`);
  }
});

// Add missing models to pricing
scraped.forEach(model => {
  if (!pricing.pricing[model]) {
    pricing.pricing[model] = {
      inputCostPerMillion: 0.00,
      outputCostPerMillion: 0.00,
      category: "Demo models",
      tier: "standard",
      multiplier: 1
    };
    pricingChanges++;
    console.log(`   ✓ Added ${model} to modelPricing.json (cost: $0.00)`);
  }
});

// Update lastUpdated date
const today = new Date().toISOString().split('T')[0];
pricing.metadata.lastUpdated = today;

// Sort the estimators object by key
const sortedEstimators = {};
Object.keys(estimators.estimators).sort().forEach(key => {
  sortedEstimators[key] = estimators.estimators[key];
});
estimators.estimators = sortedEstimators;

// Write updated files
fs.writeFileSync('src/tokenEstimators.json', JSON.stringify(estimators, null, 2) + '\n');
fs.writeFileSync('src/modelPricing.json', JSON.stringify(pricing, null, 2) + '\n');

console.log('');
console.log(`Summary: ${estimatorChanges} models added to estimators, ${pricingChanges} to pricing`);
UPDATE_EOF

node /tmp/update-models.js
echo ""

echo -e "${BLUE}Step 5: Show changes${NC}"
echo "   Comparing before and after"
echo ""

# Show diff
echo "Changes to tokenEstimators.json:"
diff -u src/tokenEstimators.json.backup src/tokenEstimators.json || true
echo ""

echo "Changes to modelPricing.json (first 20 lines):"
diff -u src/modelPricing.json.backup src/modelPricing.json | head -20 || true
echo ""

echo -e "${BLUE}Step 6: Verify changes${NC}"
echo "   Ensuring JSON files are valid"
echo ""

if jq empty src/tokenEstimators.json && jq empty src/modelPricing.json; then
    echo -e "${GREEN}✓ Both JSON files are valid${NC}"
else
    echo -e "${RED}✗ JSON validation failed${NC}"
    exit 1
fi
echo ""

# Count new totals
NEW_ESTIMATOR_COUNT=$(jq '.estimators | length' src/tokenEstimators.json)
NEW_PRICING_COUNT=$(jq '.pricing | length' src/modelPricing.json)

echo "Final model counts:"
echo -e "   tokenEstimators.json: ${ESTIMATOR_COUNT} → ${GREEN}${NEW_ESTIMATOR_COUNT}${NC} (+$((NEW_ESTIMATOR_COUNT - ESTIMATOR_COUNT)))"
echo -e "   modelPricing.json: ${PRICING_COUNT} → ${GREEN}${NEW_PRICING_COUNT}${NC} (+$((NEW_PRICING_COUNT - PRICING_COUNT)))"
echo ""

echo -e "${BLUE}Step 7: Restore original files${NC}"
echo "   Cleaning up demo changes"
echo ""

# Restore backups
mv src/tokenEstimators.json.backup src/tokenEstimators.json
mv src/modelPricing.json.backup src/modelPricing.json

echo -e "${GREEN}✓ Original files restored${NC}"
echo ""

echo "🎉 Demo complete!"
echo ""
echo "In production, the workflow would:"
echo "  1. Run weekly via cron schedule"
echo "  2. Scrape live data from GitHub documentation"
echo "  3. Use GitHub Copilot CLI to intelligently update files"
echo "  4. Create a pull request with the changes"
echo "  5. Include notes about pricing verification needed"
echo ""
echo "To trigger the real workflow manually:"
echo "  gh workflow run check-models.yml"
echo ""
