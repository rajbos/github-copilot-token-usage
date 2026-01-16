#!/usr/bin/env node

/**
 * JSON Validation Script
 * 
 * This script validates the tokenEstimators.json and modelPricing.json files
 * to ensure they have correct structure and valid data.
 * 
 * Usage: node validate-json.js
 */

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../../../src');
const tokenEstimatorsPath = path.join(srcDir, 'tokenEstimators.json');
const modelPricingPath = path.join(srcDir, 'modelPricing.json');

let hasErrors = false;

function logError(message) {
    console.error(`❌ ERROR: ${message}`);
    hasErrors = true;
}

function logSuccess(message) {
    console.log(`✅ ${message}`);
}

function logWarning(message) {
    console.warn(`⚠️  WARNING: ${message}`);
}

console.log('Validating JSON data files...\n');

// Validate tokenEstimators.json
try {
    console.log('Checking tokenEstimators.json...');
    
    if (!fs.existsSync(tokenEstimatorsPath)) {
        logError('tokenEstimators.json not found');
    } else {
        const content = fs.readFileSync(tokenEstimatorsPath, 'utf8');
        const data = JSON.parse(content);
        
        if (!data.estimators) {
            logError('Missing "estimators" object in tokenEstimators.json');
        } else {
            const estimators = data.estimators;
            const modelCount = Object.keys(estimators).length;
            
            logSuccess(`Found ${modelCount} model estimators`);
            
            // Validate each estimator
            for (const [model, ratio] of Object.entries(estimators)) {
                if (typeof ratio !== 'number') {
                    logError(`Model "${model}": ratio must be a number, got ${typeof ratio}`);
                } else if (ratio < 0.15 || ratio > 0.35) {
                    logWarning(`Model "${model}": ratio ${ratio} is outside typical range (0.15-0.35)`);
                }
            }
            
            logSuccess('tokenEstimators.json structure is valid');
        }
    }
} catch (error) {
    logError(`Failed to parse tokenEstimators.json: ${error.message}`);
}

console.log('');

// Validate modelPricing.json
try {
    console.log('Checking modelPricing.json...');
    
    if (!fs.existsSync(modelPricingPath)) {
        logError('modelPricing.json not found');
    } else {
        const content = fs.readFileSync(modelPricingPath, 'utf8');
        const data = JSON.parse(content);
        
        // Check metadata
        if (!data.metadata) {
            logError('Missing "metadata" object in modelPricing.json');
        } else {
            if (!data.metadata.lastUpdated) {
                logWarning('Missing "lastUpdated" in metadata');
            } else {
                logSuccess(`Last updated: ${data.metadata.lastUpdated}`);
            }
            
            if (!data.metadata.sources || !Array.isArray(data.metadata.sources)) {
                logWarning('Missing or invalid "sources" array in metadata');
            } else {
                logSuccess(`Found ${data.metadata.sources.length} pricing sources`);
            }
        }
        
        // Check pricing data
        if (!data.pricing) {
            logError('Missing "pricing" object in modelPricing.json');
        } else {
            const pricing = data.pricing;
            const modelCount = Object.keys(pricing).length;
            
            logSuccess(`Found ${modelCount} model pricing entries`);
            
            // Validate each pricing entry
            for (const [model, priceData] of Object.entries(pricing)) {
                if (!priceData.inputCostPerMillion) {
                    logError(`Model "${model}": missing inputCostPerMillion`);
                } else if (typeof priceData.inputCostPerMillion !== 'number') {
                    logError(`Model "${model}": inputCostPerMillion must be a number`);
                } else if (priceData.inputCostPerMillion < 0) {
                    logError(`Model "${model}": inputCostPerMillion must be positive`);
                }
                
                if (!priceData.outputCostPerMillion) {
                    logError(`Model "${model}": missing outputCostPerMillion`);
                } else if (typeof priceData.outputCostPerMillion !== 'number') {
                    logError(`Model "${model}": outputCostPerMillion must be a number`);
                } else if (priceData.outputCostPerMillion < 0) {
                    logError(`Model "${model}": outputCostPerMillion must be positive`);
                }
                
                if (!priceData.category) {
                    logWarning(`Model "${model}": missing category field`);
                }
            }
            
            logSuccess('modelPricing.json structure is valid');
        }
    }
} catch (error) {
    logError(`Failed to parse modelPricing.json: ${error.message}`);
}

console.log('\n' + '='.repeat(60));

if (hasErrors) {
    console.error('\n❌ Validation failed with errors');
    process.exit(1);
} else {
    console.log('\n✅ All validations passed!');
    process.exit(0);
}
