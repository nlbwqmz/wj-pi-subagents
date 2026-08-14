import { fileURLToPath } from "node:url";
import { createPiSubagentExtension } from "../src/host-gate.ts";
import { createPiSubagentRuntimeActivator } from "../src/pi-subagent-runtime.ts";

// 子 Pi 必须加载当前实际入口，而不是按包名重新解析潜在的另一份安装。
const activatePiSubagentRuntime = createPiSubagentRuntimeActivator({
  selfExtensionPath: fileURLToPath(import.meta.url),
});

export default createPiSubagentExtension({ activate: activatePiSubagentRuntime });
