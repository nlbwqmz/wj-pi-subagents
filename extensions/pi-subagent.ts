import { createPiSubagentExtension } from "../src/host-gate.ts";
import { activatePiSubagentRuntime } from "../src/pi-subagent-runtime.ts";

export default createPiSubagentExtension({ activate: activatePiSubagentRuntime });
