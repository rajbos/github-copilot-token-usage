# Sync Copilot Model Data

Update `src/tokenEstimators.json` and `src/modelPricing.json` with missing models found in the scraped documentation data.

## Requirements

1. Scraped model data is available in `.github/scripts/scraped-models.json` - this is the source of truth for which models are supported by GitHub Copilot.
2. Read the scraped models list and compare it to:
   - `src/tokenEstimators.json` - contains character-to-token ratio estimators
   - `src/modelPricing.json` - contains pricing data (cost per million tokens)
3. For each model in the scraped data that is missing from either JSON file:
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

- Update `lastUpdated` field in `src/modelPricing.json` to today's date (YYYY-MM-DD format)
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
