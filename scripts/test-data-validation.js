#!/usr/bin/env node
/**
 * Test script to verify test data is valid and can be processed
 * 
 * This script simulates the extension's token estimation logic
 * to verify that test data files are correctly formatted and can
 * produce token counts.
 */

const fs = require('fs');
const path = require('path');

// Token estimators (simplified version from extension)
const tokenEstimators = {
    'gpt-4o-2024-11-20': 0.28,
    'gpt-4o': 0.28,
    'claude-3.5-sonnet': 0.29,
    'o1-2024-12-17': 0.27,
    'o1': 0.27
};

function estimateTokens(text, model = 'gpt-4o') {
    if (!text) return 0;
    const ratio = tokenEstimators[model] || 0.28;
    return Math.round(text.length * ratio);
}

function processSessionFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const session = JSON.parse(content);
        
        let inputTokens = 0;
        let outputTokens = 0;
        let interactions = 0;
        
        if (!session.requests || !Array.isArray(session.requests)) {
            throw new Error('No requests array found in session file');
        }
        
        for (const request of session.requests) {
            interactions++;
            
            // Get model for this request
            const model = request.result?.metadata?.model || 'gpt-4o';
            
            // Count input tokens
            if (request.message?.parts) {
                for (const part of request.message.parts) {
                    if (part.text) {
                        inputTokens += estimateTokens(part.text, model);
                    }
                }
            }
            
            // Count output tokens
            if (request.response && Array.isArray(request.response)) {
                for (const item of request.response) {
                    if (item.value) {
                        outputTokens += estimateTokens(item.value, model);
                    }
                }
            }
        }
        
        return {
            success: true,
            sessionId: session.sessionId,
            interactions,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            mode: session.mode
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// Main test execution
console.log('🧪 Testing Session Data Files\n');
console.log('=' .repeat(60));

const testDataDir = path.join(__dirname, '..', 'test-data', 'chatSessions');

if (!fs.existsSync(testDataDir)) {
    console.error('❌ Test data directory not found:', testDataDir);
    process.exit(1);
}

const files = fs.readdirSync(testDataDir).filter(f => f.endsWith('.json'));

if (files.length === 0) {
    console.error('❌ No JSON files found in:', testDataDir);
    process.exit(1);
}

console.log(`Found ${files.length} test data file(s)\n`);

let totalSuccess = 0;
let totalFailed = 0;
let grandTotalTokens = 0;
let grandTotalInteractions = 0;

for (const file of files) {
    const filePath = path.join(testDataDir, file);
    console.log(`\n📄 ${file}`);
    console.log('-'.repeat(60));
    
    const result = processSessionFile(filePath);
    
    if (result.success) {
        totalSuccess++;
        grandTotalTokens += result.totalTokens;
        grandTotalInteractions += result.interactions;
        
        console.log(`✅ Valid session data`);
        console.log(`   Session ID: ${result.sessionId}`);
        console.log(`   Mode: ${result.mode}`);
        console.log(`   Interactions: ${result.interactions}`);
        console.log(`   Input tokens: ${result.inputTokens.toLocaleString()}`);
        console.log(`   Output tokens: ${result.outputTokens.toLocaleString()}`);
        console.log(`   Total tokens: ${result.totalTokens.toLocaleString()}`);
    } else {
        totalFailed++;
        console.log(`❌ Invalid session data`);
        console.log(`   Error: ${result.error}`);
    }
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('📊 Test Summary\n');
console.log(`   Total files: ${files.length}`);
console.log(`   ✅ Valid: ${totalSuccess}`);
console.log(`   ❌ Failed: ${totalFailed}`);
console.log(`   Total interactions: ${grandTotalInteractions}`);
console.log(`   Total estimated tokens: ${grandTotalTokens.toLocaleString()}`);

if (totalFailed > 0) {
    console.log('\n❌ Some test files failed validation');
    process.exit(1);
} else {
    console.log('\n✅ All test files are valid!');
    console.log('\n💡 You can now use these files for screenshot generation.');
    console.log('   Run: node scripts/screenshot-ui-views.js');
    process.exit(0);
}
