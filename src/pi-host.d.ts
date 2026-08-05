declare module "@earendil-works/pi-coding-agent" {
  export const VERSION: string;
  export const RpcClient: new (...args: unknown[]) => unknown;
}
