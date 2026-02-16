#!/usr/bin/env node

/**
 * JSON Validation Script
 * 
 * Validates that all JSON files in the repository contain valid JSON.
 * This script is run as part of the CI build process to catch JSON syntax errors early.
 */

const fs = require('fs');
const path = require('path');

// Try to load jsonc-parser, fallback to strip-json-comments if not available
let parseJsonc;
try {
  const jsoncParser = require('jsonc-parser');
  parseJsonc = (content) => {
    const errors = [];
    const result = jsoncParser.parse(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const error = errors[0];
      throw new Error(`${jsoncParser.printParseErrorCode(error.error)} at position ${error.offset}`);
    }
    return result;
  };
} catch (e) {
  // Fallback to strip-json-comments
  const stripJsonComments = require('strip-json-comments');
  parseJsonc = (content) => JSON.parse(stripJsonComments(content));
}

// Directories and patterns to exclude from JSON validation
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /out/,
  /coverage/,
  /\.vscode-test/,
  /tmp/,
  /\.vsix$/,
];

// JSON files to validate (relative to repo root)
const JSON_FILES = [
  // Core configuration files
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.tests.json',
  '.stylelintrc.json',
  
  // Extension data files
  'src/tokenEstimators.json',
  'src/modelPricing.json',
  'src/toolNames.json',
  'src/customizationPatterns.json',
  
  // VS Code configuration
  '.vscode/settings.json',
  '.vscode/launch.json',
  '.vscode/tasks.json',
  '.vscode/extensions.json',
  
  // DevContainer configuration
  '.devcontainer/devcontainer.json',
  
  // Documentation schema files
  'docs/logFilesSchema/session-file-schema.json',
  'docs/logFilesSchema/session-file-schema-analysis.json',
];

// Files that support JSONC (JSON with Comments)
const JSONC_FILES = new Set([
  'tsconfig.json',
  'tsconfig.tests.json',
  '.vscode/settings.json',
  '.vscode/launch.json',
  '.vscode/tasks.json',
  '.vscode/extensions.json',
  '.devcontainer/devcontainer.json',
]);

/**
 * Check if a file path should be excluded
 */
function shouldExclude(filePath) {
  return EXCLUDE_PATTERNS.some(pattern => pattern.test(filePath));
}

/**
 * Validate a single JSON file
 */
function validateJsonFile(filePath, isJsonc = false) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Use JSONC parser for JSONC files, standard JSON.parse for others
    if (isJsonc) {
      parseJsonc(content);
    } else {
      JSON.parse(content);
    }
    
    return { valid: true, file: filePath };
  } catch (error) {
    return {
      valid: false,
      file: filePath,
      error: error.message,
      line: error.message.match(/position (\d+)/)?.[1] || 'unknown'
    };
  }
}

/**
 * Main validation function
 */
function main() {
  console.log('🔍 Validating JSON files...\n');
  
  const repoRoot = path.resolve(__dirname, '..');
  const results = [];
  const errors = [];
  
  // Validate each file
  for (const relativeFilePath of JSON_FILES) {
    const absolutePath = path.join(repoRoot, relativeFilePath);
    
    // Check if file exists
    if (!fs.existsSync(absolutePath)) {
      console.log(`⚠️  Skipping ${relativeFilePath} (file not found)`);
      continue;
    }
    
    // Skip if file should be excluded
    if (shouldExclude(absolutePath)) {
      console.log(`⏭️  Skipping ${relativeFilePath} (excluded)`);
      continue;
    }
    
    // Validate the JSON file (with JSONC support if needed)
    const isJsonc = JSONC_FILES.has(relativeFilePath);
    const result = validateJsonFile(absolutePath, isJsonc);
    results.push(result);
    
    if (result.valid) {
      console.log(`✅ ${relativeFilePath}`);
    } else {
      console.error(`❌ ${relativeFilePath}`);
      console.error(`   Error: ${result.error}`);
      errors.push(result);
    }
  }
  
  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Validation Summary:`);
  console.log(`   Total files checked: ${results.length}`);
  console.log(`   Valid: ${results.filter(r => r.valid).length}`);
  console.log(`   Invalid: ${errors.length}`);
  console.log(`${'='.repeat(60)}\n`);
  
  // Exit with error code if any validation failed
  if (errors.length > 0) {
    console.error(`❌ JSON validation failed for ${errors.length} file(s)!\n`);
    process.exit(1);
  }
  
  console.log('✅ All JSON files are valid!\n');
  process.exit(0);
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { validateJsonFile, shouldExclude };
