# This script compiles the extension and packages it into a .vsix file.

# Ensure the script stops on errors
$ErrorActionPreference = "Stop"
#0 Install dependencies
Write-Host "Installing dependencies..."
npm install

# 1. Run the compile script to build the JavaScript output
Write-Host "Compiling extension..."
npm run compile

# 2. Run vsce to package the extension
Write-Host "Packaging extension into a .vsix file..."
npx vsce package

Write-Host "Build complete! The .vsix file has been created in the root directory."
