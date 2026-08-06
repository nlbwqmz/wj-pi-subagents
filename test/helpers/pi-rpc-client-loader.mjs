const FAKE_RPC_CLIENT_URL = new URL("./fake-pi-rpc-client.mjs", import.meta.url).href;

/** 仅在生产 bridge 协议集成中把 Pi 包解析到本地无网络替身。 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: FAKE_RPC_CLIENT_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
