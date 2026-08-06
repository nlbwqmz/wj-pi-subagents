export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  settled(): boolean;
}

/** 两种监督传输适配器共享的单次完成信号。 */
export function createDeferred<T>(): Deferred<T> {
  let done = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    rejectPromise = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: () => done,
  };
}

/** 观察者异常不会破坏唯一监督读取者或协议状态。 */
export function notifySupervisorListeners<T>(
  listeners: ReadonlySet<(value: T) => void>,
  value: T,
): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // 观察者故障由所属路由层处理。
    }
  }
}

export function supervisorAbortError(): Error {
  const error = new Error("监督通道阶段已取消");
  error.name = "AbortError";
  return error;
}

/** 等待信号或期限先到；无论哪一方先完成都会取消定时器。 */
export function waitForSupervisorSignal(signal: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const complete = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(complete, timeoutMs);
    timer.unref?.();
    void signal.then(complete, complete);
  });
}

/** 把任意监督阶段与 AbortSignal 竞速，并统一稳定错误。 */
export function raceSupervisorAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(supervisorAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(supervisorAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("监督通道不可用"));
      },
    );
  });
}
