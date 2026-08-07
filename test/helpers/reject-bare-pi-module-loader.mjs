/** 显式模块路径回归测试禁止 bridge 偷偷回退到裸包名。 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    throw new Error("bridge 不得使用裸 Pi 模块导入");
  }
  return nextResolve(specifier, context);
}
