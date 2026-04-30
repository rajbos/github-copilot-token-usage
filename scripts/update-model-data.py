#!/usr/bin/env python3
"""
Update vscode-extension/src/modelPricing.json and
vscode-extension/src/tokenEstimators.json from the model data published at
rajbos/github-copilot-model-notifier.

For each model in the source:
  - Updates the `multiplier` and `tier` fields for existing models
  - Updates `copilotPricing.releaseStatus` when that block already exists
  - Adds stub entries (with $0.00 pricing) for previously unknown models
  - Adds token estimator entries for new models

Usage:
    python scripts/update-model-data.py

Env:
    GITHUB_TOKEN  Optional. Used to authenticate GitHub API requests.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

MODELS_DATA_URL = (
    "https://api.github.com/repos/rajbos/"
    "github-copilot-model-notifier/contents/data/models.json"
)

REPO_ROOT = Path(__file__).resolve().parent.parent
PRICING_PATH = REPO_ROOT / "vscode-extension" / "src" / "modelPricing.json"
ESTIMATORS_PATH = REPO_ROOT / "vscode-extension" / "src" / "tokenEstimators.json"


def api_request(url: str) -> dict | list:
    """Make an authenticated GitHub API request and return parsed JSON."""
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "github-copilot-token-usage-updater",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP error {e.code} fetching {url}: {e.reason}\n")
        raise


def fetch_source_models() -> tuple[dict, str]:
    """Fetch data/models.json from the notifier repo.

    Returns (models_dict, blob_sha) where models_dict maps
    display name → {multiplier_paid, multiplier_free, provider, release_status}.
    """
    response = api_request(MODELS_DATA_URL)
    content = base64.b64decode(response["content"]).decode("utf-8")
    sha = response.get("sha", "<unknown>")
    return json.loads(content), sha


def normalize_display_name(display_name: str) -> str:
    """Convert display name to model ID format (lowercase, spaces → hyphens).

    Examples:
      "GPT-5.4 mini"                        → "gpt-5.4-mini"
      "Claude Opus 4.6 (fast mode) (preview)" → "claude-opus-4.6-(fast-mode)-(preview)"
    """
    return re.sub(r"\s+", "-", display_name.lower())


def parse_multiplier_paid(raw: str) -> float | None:
    """Parse multiplier_paid value.

    Returns None when the source says 'Not applicable', meaning the model has
    no paid-tier multiplier (free-only model). Callers should treat None as
    "leave the existing value unchanged" rather than overwriting with 0.
    """
    if raw.strip().lower() == "not applicable":
        return None
    try:
        return float(raw)
    except ValueError:
        sys.stderr.write(f"Warning: unparseable multiplier {raw!r}, skipping\n")
        return None


def infer_tier(multiplier_paid: float | None) -> str:
    """Infer tier string from paid multiplier."""
    if multiplier_paid is None:
        return "standard"
    return "premium" if multiplier_paid > 0 else "standard"


def infer_category(display_name: str, provider: str) -> str:
    """Infer model category string using provider as primary signal."""
    name = display_name.lower()
    provider_lower = provider.lower()

    if provider_lower == "microsoft":
        return "GitHub Copilot fine-tuned models"

    if provider_lower == "anthropic":
        return "Claude models (Anthropic)"

    if provider_lower == "google":
        return "Google Gemini models"

    if provider_lower == "xai":
        return "xAI Grok models"

    # OpenAI: distinguish model families by name
    if re.match(r"^o\d", name):
        return "OpenAI reasoning models"
    if name.startswith("gpt-5") or name.startswith("gpt 5"):
        return "GPT-5 models"
    if name.startswith("gpt-4") or name.startswith("gpt 4"):
        return "GPT-4 models"

    return f"{provider} models"


def infer_token_ratio(display_name: str) -> float:
    """Infer character-to-token ratio from model family."""
    if display_name.lower().startswith("claude"):
        return 0.24
    return 0.25


def find_model_key(pricing: dict, display_name: str, normalized: str) -> str | None:
    """Find existing model key in pricing by normalized ID or displayNames array."""
    if normalized in pricing:
        return normalized
    display_name_lower = display_name.lower()
    for key, entry in pricing.items():
        for alias in entry.get("displayNames", []):
            if alias.lower() == display_name_lower:
                return key
    return None


def format_float(value: float) -> str:
    """Format float for diff summary output."""
    if value == int(value):
        return str(int(value))
    return str(value)


def main() -> int:
    print("Fetching model data from rajbos/github-copilot-model-notifier...")
    try:
        source_models, source_sha = fetch_source_models()
    except Exception as e:
        sys.stderr.write(f"Failed to fetch source models: {e}\n")
        return 1

    print(f"Source SHA: {source_sha}")
    print(f"Found {len(source_models)} models in source")

    pricing_data = json.loads(PRICING_PATH.read_text(encoding="utf-8"))
    estimators_data = json.loads(ESTIMATORS_PATH.read_text(encoding="utf-8"))

    pricing = pricing_data["pricing"]
    estimators = estimators_data["estimators"]

    pricing_changed = False
    estimators_changed = False

    field_updates: list[str] = []
    new_models: list[str] = []

    for display_name, source_entry in source_models.items():
        provider = source_entry.get("provider", "Unknown")
        release_status = source_entry.get("release_status", "")
        raw_paid = source_entry.get("multiplier_paid", "Not applicable")
        multiplier_paid = parse_multiplier_paid(raw_paid)
        new_tier = infer_tier(multiplier_paid)
        normalized = normalize_display_name(display_name)
        existing_key = find_model_key(pricing, display_name, normalized)

        if existing_key is not None:
            entry = pricing[existing_key]

            # Only update multiplier when the source has an actual value.
            if multiplier_paid is not None and entry.get("multiplier") != multiplier_paid:
                old = format_float(entry.get("multiplier", "?"))
                entry["multiplier"] = multiplier_paid
                field_updates.append(
                    f"  ~ {existing_key}: multiplier {old} → {format_float(multiplier_paid)}"
                )
                pricing_changed = True

            # Update tier when we have a definitive value and it differs.
            current_tier = entry.get("tier", "unknown")
            if current_tier != new_tier and new_tier != "unknown":
                entry["tier"] = new_tier
                field_updates.append(
                    f"  ~ {existing_key}: tier {current_tier!r} → {new_tier!r}"
                )
                pricing_changed = True

            # Update releaseStatus inside copilotPricing only when it already exists.
            copilot_block = entry.get("copilotPricing")
            if copilot_block and release_status:
                normalized_status = release_status
                if copilot_block.get("releaseStatus") != normalized_status:
                    old_status = copilot_block.get("releaseStatus", "?")
                    copilot_block["releaseStatus"] = normalized_status
                    field_updates.append(
                        f"  ~ {existing_key}: copilotPricing.releaseStatus "
                        f"{old_status!r} → {normalized_status!r}"
                    )
                    pricing_changed = True

        else:
            # New model — add a stub with $0.00 pricing.
            category = infer_category(display_name, provider)
            ratio = infer_token_ratio(display_name)
            stub_multiplier = multiplier_paid if multiplier_paid is not None else 0.0

            pricing[normalized] = {
                "inputCostPerMillion": 0.00,
                "outputCostPerMillion": 0.00,
                "category": category,
                "tier": infer_tier(stub_multiplier),
                "multiplier": stub_multiplier,
                "displayNames": [display_name],
            }
            new_models.append(
                f"  + {normalized} ({display_name}, "
                f"provider={provider}, multiplier={format_float(stub_multiplier)})"
            )
            pricing_changed = True

            if normalized not in estimators:
                estimators[normalized] = ratio
                estimators_changed = True

    if not pricing_changed and not estimators_changed:
        print(f"No changes detected. Source SHA: {source_sha}")
        return 0

    if field_updates:
        print("Updated fields:")
        for line in field_updates:
            print(line)

    if new_models:
        print("Added new model stubs (⚠️ pricing requires manual verification):")
        for line in new_models:
            print(line)

    if pricing_changed:
        pricing_data["metadata"]["lastUpdated"] = date.today().isoformat()
        PRICING_PATH.write_text(
            json.dumps(pricing_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Updated {PRICING_PATH.relative_to(REPO_ROOT)}")

    if estimators_changed:
        ESTIMATORS_PATH.write_text(
            json.dumps(estimators_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Updated {ESTIMATORS_PATH.relative_to(REPO_ROOT)}")

    # Emit source SHA so callers / CI can surface it.
    print(f"SOURCE_SHA={source_sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
