// Extension: ai-fluency
// Canvas over the AI Engineering Fluency CLI (`@rajbos/ai-engineering-fluency`):
// usage overview, recent sessions, and fluency score. Ships in the
// `ai-fluency-canvas` Copilot plugin (copilot-app/ in the repo) and can also be
// copied into `$COPILOT_HOME/extensions/ai-fluency/` by hand. See README.md.
// The registration itself lives in canvas.mjs, which is tested with a stub SDK.

import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { startExtension } from "./canvas.mjs";

await startExtension({ createCanvas, CanvasError, joinSession });