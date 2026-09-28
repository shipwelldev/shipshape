import { piStateDir } from "../config/paths.js";

// Pi fixes its agent directory (managed rg/fd downloads, crash logs, caches) when its
// modules load, so point it at Ship Shape's own cache before anything imports Pi.
// This keeps a user's ~/.pi installation out of every review. Ship Shape also never
// opts into Pi's install telemetry or provider attribution headers.
// Import this module before any module that loads Pi.
process.env.PI_CODING_AGENT_DIR = piStateDir();
process.env.PI_TELEMETRY = "0";
