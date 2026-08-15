import { fileURLToPath } from "node:url";
import { createWjPiSubagentsExtension } from "./src/host-gate.ts";
import { createWjPiSubagentsRuntimeActivator } from "./src/wj-pi-subagents-runtime.ts";

// 子 Pi 必须加载当前实际入口，而不是按包名重新解析潜在的另一份安装。
const activateWjPiSubagentsRuntime = createWjPiSubagentsRuntimeActivator({
  selfExtensionPath: fileURLToPath(import.meta.url),
});

export default createWjPiSubagentsExtension({ activate: activateWjPiSubagentsRuntime });
