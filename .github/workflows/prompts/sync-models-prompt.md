# Sync Copilot Model Data

Update `src/tokenEstimators.json` and `src/modelPricing.json` with missing models found in GitHub Copilot documentation.

## Requirements

1. Fetch and parse the GitHub Copilot supported models documentation page:
   - URL: https://docs.github.com/en/copilot/reference/ai-models/supported-models
   - Extract all model names from the "Supported AI models in Copilot" section
   - Model names should be normalized (lowercase, hyphens instead of spaces)
2. Compare the extracted models list to:
   - `src/tokenEstimators.json` - contains character-to-token ratio estimators
   - `src/modelPricing.json` - contains pricing data (cost per million tokens)
3. For each model from the documentation that is missing from either JSON file:
   - Add it to the appropriate JSON file(s)
   - Use sensible defaults based on existing similar models

## Token Estimators (`src/tokenEstimators.json`)

For missing models in tokenEstimators.json:
- Add new entry to the `estimators` object
- Use a default ratio of `0.25` (4 characters per token) unless you can infer from model family:
  - GPT-4 models: `0.25`
  - GPT-3.5 models: `0.25`
  - Claude models: `0.25`
  - o1 models: `0.25`
- Format example:
  ```json
  "gpt-4o": 0.25
  ```
- Maintain alphabetical ordering within model families
- Group related models together (e.g., all gpt-4 variants, all claude variants)

## Model Pricing (`src/modelPricing.json`)

For missing models in modelPricing.json:
- Add new entry to the `pricing` object
- Structure:
  ```json
  "model-name": {
    "input": 0.00,
    "output": 0.00
  }
  ```
- Where `input` and `output` are cost per million tokens
- Use `0.00` as default (pricing will need manual verification later)
- Add a note to the PR body that pricing needs verification
- Maintain alphabetical ordering within model families
- Group related models together

## Metadata Updates

- **ONLY** update `lastUpdated` field in `src/modelPricing.json` to today's date (YYYY-MM-DD format) **if you added new models to the pricing file**
- If no models were added, do NOT update the `lastUpdated` field
- Do NOT modify the `sources` section unless you have specific pricing data

## Output Format

1. Make all necessary changes to both JSON files
2. Ensure proper JSON formatting (2-space indentation)
3. Maintain existing structure and patterns
4. If no changes are needed, do nothing

## Constraints

- Only modify `src/tokenEstimators.json` and `src/modelPricing.json`
- Do not open a PR (the workflow will handle that)
- Preserve all existing entries and formatting conventions
- Use consistent spacing and indentation with existing file style
- Models should be normalized (lowercase, hyphens instead of spaces)
